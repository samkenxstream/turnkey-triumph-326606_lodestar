import PeerId from "peer-id";
import {AbortSignal} from "abort-controller";
import {BeaconBlocksByRangeRequest, Epoch, Root, SignedBeaconBlock, Slot} from "@chainsafe/lodestar-types";
import {ErrorAborted, ILogger} from "@chainsafe/lodestar-utils";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ChainSegmentError} from "../../chain/errors";
import {ItTrigger} from "../../util/itTrigger";
import {prettyTimeDiff} from "../../util/time";
import {TimeSeries} from "../stats/timeSeries";
import {ChainPeersBalancer} from "./utils/peerBalancer";
import {PeerSet} from "./utils/peerMap";
import {Batch, BatchOpts, BatchStatus} from "./batch";
import {
  validateBatchesStatus,
  getNextBatchToProcess,
  toBeProcessedStartEpoch,
  toBeDownloadedStartEpoch,
  toArr,
} from "./utils/batches";
import {computeEpochAtSlot, computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";

export type SyncChainOpts = BatchOpts & {maybeStuckTimeoutMs: number};

/**
 * Should return if ALL blocks are processed successfully
 * If SOME blocks are processed must throw BlockProcessorError()
 */
export type ProcessChainSegment = (blocks: SignedBeaconBlock[]) => Promise<void>;

export type DownloadBeaconBlocksByRange = (
  peer: PeerId,
  request: BeaconBlocksByRangeRequest
) => Promise<SignedBeaconBlock[]>;

/**
 * Sync this up to this target. Uses slot instead of epoch to re-use logic for finalized sync
 * and head sync. The root is used to uniquely identify this chain on different forks
 */
export type ChainTarget = {
  slot: Slot;
  root: Root;
};

/**
 * Blocks are downloaded in batches from peers. This constant specifies how many epochs worth of
 * blocks per batch are requested _at most_. A batch may request less blocks to account for
 * already requested slots. There is a timeout for each batch request. If this value is too high,
 * we will negatively report peers with poor bandwidth. This can be set arbitrarily high, in which
 * case the responder will fill the response up to the max request size, assuming they have the
 * bandwidth to do so.
 */
const EPOCHS_PER_BATCH = 2;

/**
 * The maximum number of batches to queue before requesting more.
 */
const BATCH_BUFFER_SIZE = 5;

/**
 * If no batch is processed during this time, trigger the downloader and processor again
 */
const MAYBE_STUCK_TIMEOUT = 10 * 1000;

enum SyncState {
  Stopped = "Stopped",
  Syncing = "Syncing",
  Error = "Error",
}

export class SyncChain {
  state = SyncState.Stopped;
  /** The start of the chain segment. Any epoch previous to this one has been validated. */
  startEpoch: Epoch;
  /** Should sync up until this slot, then stop */
  target: ChainTarget;
  /** Number of validated epochs. For the SyncRange to prevent switching chains too fast */
  validatedEpochs = 0;
  /** A multi-threaded, non-blocking processor for applying messages to the beacon chain. */
  private processChainSegment: ProcessChainSegment;
  private downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange;
  /** AsyncIterable that guarantees processChainSegment is run only at once at anytime */
  private batchProcessor = new ItTrigger();
  private maybeStuckTimeout!: NodeJS.Timeout; // clearTimeout(undefined) is okay
  /** Sorted map of batches undergoing some kind of processing. */
  private batches = new Map<Epoch, Batch>();
  private peerset = new PeerSet();

  /** Dynamic targetEpoch with associated peers. May be `null`ed if no suitable peer set exists */
  private timeSeries = new TimeSeries({maxPoints: 1000});
  private logger: ILogger;
  private config: IBeaconConfig;
  private signal: AbortSignal;
  private opts: SyncChainOpts;

  constructor(
    startEpoch: Epoch,
    target: ChainTarget,
    processChainSegment: ProcessChainSegment,
    downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange,
    config: IBeaconConfig,
    logger: ILogger,
    signal: AbortSignal,
    opts?: SyncChainOpts
  ) {
    this.startEpoch = startEpoch;
    this.target = target;
    this.processChainSegment = processChainSegment;
    this.downloadBeaconBlocksByRange = downloadBeaconBlocksByRange;
    this.config = config;
    this.logger = logger;
    this.signal = signal;
    this.opts = {
      epochsPerBatch: opts?.epochsPerBatch ?? EPOCHS_PER_BATCH,
      maybeStuckTimeoutMs: opts?.maybeStuckTimeoutMs ?? MAYBE_STUCK_TIMEOUT,
    };

    this.signal.addEventListener("abort", () => {
      clearTimeout(this.maybeStuckTimeout);
      this.batchProcessor.end(new ErrorAborted("SyncChain"));
    });
  }

  /// Either a new chain, or an old one with a peer list
  /// This chain has been requested to start syncing.
  ///
  /// This could be new chain, or an old chain that is being resumed.
  async startSyncing(localFinalizedEpoch: Epoch): Promise<void> {
    // to avoid dropping local progress, we advance the chain wrt its batch boundaries.
    // get the *aligned* epoch that produces a batch containing the `local_finalized_epoch`
    const alignedLocalFinalizedEpoch =
      this.startEpoch + Math.floor((localFinalizedEpoch - this.startEpoch) / EPOCHS_PER_BATCH) * EPOCHS_PER_BATCH;
    this.advanceChain(alignedLocalFinalizedEpoch);

    this.advanceChain(this.startEpoch);

    this.state = SyncState.Syncing;

    await this.sync();
  }

  stopSyncing(): void {
    this.state = SyncState.Stopped;
  }

  /// Add a peer to the chain.
  /// If the chain is active, this starts requesting batches from this peer.
  addPeer(peerId: PeerId): void {
    if (!this.peerset.has(peerId)) {
      this.peerset.add(peerId);
      this.triggerBatchDownloader();
    }
  }

  removePeer(peerId: PeerId): void {
    this.peerset.delete(peerId);

    // TODO: What to do when peer count is zero?
    if (this.peerset.size === 0) {
      throw Error("RemoveChainError - EmptyPeerPool");
    }
  }

  getMetadata(): ChainTarget {
    return this.target;
  }

  get isSyncing(): boolean {
    return this.state === SyncState.Syncing;
  }

  get peers(): number {
    return this.peerset.size;
  }

  /**
   * Main Promise that handles the sync process. Will resolve when initial sync completes
   * i.e. when it successfully processes a epoch >= than this chain `targetEpoch`
   */
  private async sync(): Promise<void> {
    this.triggerBatchDownloader();
    this.triggerBatchProcessor();

    try {
      // Start processing batches on demand in strict sequence
      for await (const _ of this.batchProcessor) {
        clearTimeout(this.maybeStuckTimeout);

        if (this.state !== SyncState.Syncing) {
          continue;
        }

        // TODO: Consider running this check less often after the sync is well tested
        validateBatchesStatus(toArr(this.batches));

        // If startEpoch of the next batch to be processed > targetEpoch -> Done
        const toBeProcessedEpoch = toBeProcessedStartEpoch(toArr(this.batches), this.startEpoch, this.opts);
        if (computeStartSlotAtEpoch(this.config, toBeProcessedEpoch) >= this.target.slot) {
          break;
        }

        // Processes the next batch if ready
        const batch = getNextBatchToProcess(toArr(this.batches));
        if (batch) await this.processBatch(batch);

        this.maybeStuckTimeout = setTimeout(this.syncMaybeStuck, this.opts.maybeStuckTimeoutMs);
      }
    } finally {
      clearTimeout(this.maybeStuckTimeout);
    }

    this.logger.important("Completed initial sync");
  }

  private syncMaybeStuck = (): void => {
    this.triggerBatchDownloader();
    this.triggerBatchProcessor();
    this.logger.verbose(`SyncChain maybe stuck ${this.renderChainState()}`);
  };

  /**
   * Request to process batches if any
   */
  private triggerBatchProcessor(): void {
    this.batchProcessor.trigger();
  }

  /**
   * Request to download batches if any
   * Backlogs requests into a single pending request
   */
  private triggerBatchDownloader(): void {
    try {
      this.requestBatches(this.peerset.values());
    } catch (e) {
      // bubble the error up to the main async iterable loop
      void this.batchProcessor.throw(e);
    }
  }

  /**
   * Attempts to request the next required batches from the peer pool if the chain is syncing.
   * It will exhaust the peer pool and left over batches until the batch buffer is reached.
   *
   * The peers that agree on the same finalized checkpoint and thus available to download
   * this chain from, as well as the batches we are currently requesting.
   */
  private requestBatches(peers: PeerId[]): void {
    if (this.state !== SyncState.Syncing) {
      return;
    }

    const peerBalancer = new ChainPeersBalancer(peers, toArr(this.batches));

    // Retry download of existing batches
    for (const batch of this.batches.values()) {
      if (batch.state.status !== BatchStatus.AwaitingDownload) {
        continue;
      }

      const peer = peerBalancer.bestPeerToRetryBatch(batch);
      if (peer) {
        void this.sendBatch(batch, peer);
      }
    }

    // find the next pending batch and request it from the peer
    for (const peer of peerBalancer.idlePeers()) {
      const batch = this.includeNextBatch();
      if (!batch) {
        break;
      }
      void this.sendBatch(batch, peer);
    }
  }

  /**
   * Creates the next required batch from the chain. If there are no more batches required, `null` is returned.
   */
  private includeNextBatch(): Batch | null {
    const batches = toArr(this.batches);

    // Only request batches up to the buffer size limit
    // Note: Don't count batches in the AwaitingValidation state, to prevent stalling sync
    // if the current processing window is contained in a long range of skip slots.
    const batchesInBuffer = batches.filter((batch) => {
      return batch.state.status === BatchStatus.Downloading || batch.state.status === BatchStatus.AwaitingProcessing;
    });
    if (batchesInBuffer.length > BATCH_BUFFER_SIZE) {
      return null;
    }

    // This line decides the starting epoch of the next batch. MUST ensure no duplicate batch for the same startEpoch
    const startEpoch = toBeDownloadedStartEpoch(batches, this.startEpoch, this.opts);

    // Don't request batches beyond the target head slot
    if (computeStartSlotAtEpoch(this.config, startEpoch) > this.target.slot) {
      return null;
    }

    if (this.batches.has(startEpoch)) {
      this.logger.error("Attempting to add existing Batch to SyncChain", {startEpoch});
      return null;
    }

    const batch = new Batch(startEpoch, this.config, this.logger, this.opts);
    this.batches.set(startEpoch, batch);
    return batch;
  }

  /**
   * Requests the batch asigned to the given id from a given peer.
   */
  private async sendBatch(batch: Batch, peer: PeerId): Promise<void> {
    try {
      // Inform the batch about the new request
      batch.startDownloading(peer);

      try {
        const blocks = await this.downloadBeaconBlocksByRange(peer, batch.request);
        batch.downloadingSuccess(blocks || []);

        this.triggerBatchProcessor();
      } catch (e) {
        // Throws on MAX_DOWNLOAD_ATTEMPTS
        batch.downloadingError(e);
      } finally {
        // Pre-emptively request more blocks from peers whilst we process current blocks
        this.triggerBatchDownloader();
      }
    } catch (e) {
      // bubble the error up to the main async iterable loop
      void this.batchProcessor.throw(e);
    }
  }

  /**
   * Sends `batch` to the processor. Note: batch may be empty
   */
  private async processBatch(batch: Batch): Promise<void> {
    try {
      const blocks = batch.startProcessing();
      await this.processChainSegment(blocks);
      batch.processingSuccess();

      // If the processed batch was not empty, we can validate previous unvalidated blocks.
      if (blocks.length > 0) {
        this.advanceChain(batch.startEpoch);
      }

      // Potentially process next AwaitingProcessing batch
      this.triggerBatchProcessor();
    } catch (e) {
      batch.processingError(e);

      // At least one block was successfully verified and imported, so we can be sure all
      // previous batches are valid and we only need to download the current failed batch.
      if (e instanceof ChainSegmentError && e.importedBlocks > 0) {
        this.advanceChain(batch.startEpoch);
      }

      // The current batch could not be processed, so either this or previous batches are invalid.
      // All previous batches (awaiting validation) are potentially faulty and marked for retry
      // Progress will be drop back to this.startEpoch
      for (const pendingBatch of this.batches.values()) {
        if (pendingBatch.startEpoch < batch.startEpoch) {
          pendingBatch.validationError();
        }
      }
    } finally {
      // A batch is no longer in Processing status, queue has an empty spot to download next batch
      this.triggerBatchDownloader();
    }
  }

  /**
   * Drops any batches previous to `newStartEpoch` and updates the chain boundaries
   */
  private advanceChain(newStartEpoch: Epoch): void {
    // make sure this epoch produces an advancement
    if (newStartEpoch <= this.startEpoch) {
      return;
    }

    for (const [batchKey, batch] of this.batches.entries()) {
      if (batch.startEpoch < newStartEpoch) {
        this.batches.delete(batchKey);
        this.validatedEpochs += EPOCHS_PER_BATCH;
      }
    }

    this.startEpoch = newStartEpoch;
    this.logSyncProgress(this.startEpoch, computeEpochAtSlot(this.config, this.target.slot));
  }

  /**
   * Register sync progress in TimeSeries instance and log current speed and time left
   */
  private logSyncProgress(epoch: Epoch, targetEpoch: Epoch): void {
    this.timeSeries.addPoint(epoch);

    const epochsPerSecond = this.timeSeries.computeLinearSpeed();
    const secondsLeft = (targetEpoch - epoch) / epochsPerSecond;
    const slotsPerSecond = (epochsPerSecond * this.config.params.SLOTS_PER_EPOCH).toPrecision(3);
    const timeLeft = isFinite(secondsLeft) ? prettyTimeDiff(1000 * secondsLeft) : "unknown";
    this.logger.info(`Sync progress ${epoch}/${targetEpoch} - ${timeLeft} left - ${slotsPerSecond} slots/s`);
  }

  /**
   * Helper to print internal state for debugging when chain gets stuck
   */
  private renderChainState(): string {
    const batchesMetadata = toArr(this.batches).map((batch) => batch.getMetadata());
    return `
startEpoch: ${this.startEpoch}
batches: ${this.batches.size}
\t${"epoch"} \t${"status"}
\t${"-----"} \t${"------"}
${batchesMetadata.map(({startEpoch, status}) => `\t${startEpoch} \t${status}`).join("\n")}
`;
  }
}
