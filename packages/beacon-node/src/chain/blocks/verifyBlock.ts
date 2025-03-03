import {CachedBeaconStateAllForks, computeEpochAtSlot} from "@lodestar/state-transition";
import {allForks, bellatrix} from "@lodestar/types";
import {toHexString} from "@chainsafe/ssz";
import {IForkChoice, ExecutionStatus} from "@lodestar/fork-choice";
import {IChainForkConfig} from "@lodestar/config";
import {ILogger} from "@lodestar/utils";
import {IMetrics} from "../../metrics/index.js";
import {IExecutionEngine} from "../../execution/engine/index.js";
import {BlockError, BlockErrorCode} from "../errors/index.js";
import {IBeaconClock} from "../clock/index.js";
import {BlockProcessOpts} from "../options.js";
import {IStateRegenerator, RegenCaller} from "../regen/index.js";
import {IBlsVerifier} from "../bls/index.js";
import {IEth1ForBlockProduction} from "../../eth1/index.js";
import {ImportBlockOpts} from "./types.js";
import {POS_PANDA_MERGE_TRANSITION_BANNER} from "./utils/pandaMergeTransitionBanner.js";
import {verifyBlocksStateTransitionOnly} from "./verifyBlocksStateTransitionOnly.js";
import {verifyBlocksSignatures} from "./verifyBlocksSignatures.js";
import {verifyBlocksExecutionPayload} from "./verifyBlocksExecutionPayloads.js";

export type VerifyBlockModules = {
  bls: IBlsVerifier;
  eth1: IEth1ForBlockProduction;
  executionEngine: IExecutionEngine;
  regen: IStateRegenerator;
  clock: IBeaconClock;
  logger: ILogger;
  forkChoice: IForkChoice;
  config: IChainForkConfig;
  metrics: IMetrics | null;
};

/**
 * Verifies 1 or more blocks are fully valid; from a linear sequence of blocks.
 *
 * To relieve the main thread signatures are verified separately in workers with chain.bls worker pool.
 * In parallel it:
 * - Run full state transition in sequence
 * - Verify all block's signatures in parallel
 * - Submit execution payloads to EL in sequence
 *
 * If there's an error during one of the steps, the rest are aborted with an AbortController.
 */
export async function verifyBlocksInEpoch(
  chain: VerifyBlockModules,
  blocks: allForks.SignedBeaconBlock[],
  opts: BlockProcessOpts & ImportBlockOpts
): Promise<{
  postStates: CachedBeaconStateAllForks[];
  executionStatuses: ExecutionStatus[];
  proposerBalanceDeltas: number[];
}> {
  if (blocks.length === 0) {
    throw Error("Empty partiallyVerifiedBlocks");
  }

  const block0 = blocks[0];
  const block0Epoch = computeEpochAtSlot(block0.message.slot);

  // Ensure all blocks are in the same epoch
  for (let i = 1; i < blocks.length; i++) {
    const blockSlot = blocks[i].message.slot;
    if (block0Epoch !== computeEpochAtSlot(blockSlot)) {
      throw Error(`Block ${i} slot ${blockSlot} not in same epoch ${block0Epoch}`);
    }
  }

  // TODO: Skip in process chain segment
  // Retrieve preState from cache (regen)
  const preState0 = await chain.regen.getPreState(block0.message, RegenCaller.processBlocksInEpoch).catch((e) => {
    throw new BlockError(block0, {code: BlockErrorCode.PRESTATE_MISSING, error: e as Error});
  });

  // Ensure the state is in the same epoch as block0
  if (block0Epoch !== computeEpochAtSlot(preState0.slot)) {
    throw Error(`preState at slot ${preState0.slot} must be dialed to block epoch ${block0Epoch}`);
  }

  const abortController = new AbortController();

  try {
    const [{postStates, proposerBalanceDeltas}, , {executionStatuses, mergeBlockFound}] = await Promise.all([
      // Run state transition only
      // TODO: Ensure it yields to allow flushing to workers and engine API
      verifyBlocksStateTransitionOnly(chain, preState0, blocks, abortController.signal, opts),

      // All signatures at once
      verifyBlocksSignatures(chain, preState0, blocks, opts),

      // Execution payloads
      verifyBlocksExecutionPayload(chain, blocks, preState0, abortController.signal, opts),
    ]);

    if (mergeBlockFound !== null) {
      // merge block found and is fully valid = state transition + signatures + execution payload.
      // TODO: Will this banner be logged during syncing?
      logOnPowBlock(chain, mergeBlockFound);
    }

    return {postStates, executionStatuses, proposerBalanceDeltas};
  } finally {
    abortController.abort();
  }
}

function logOnPowBlock(chain: VerifyBlockModules, mergeBlock: bellatrix.BeaconBlock): void {
  const mergeBlockHash = toHexString(chain.config.getForkTypes(mergeBlock.slot).BeaconBlock.hashTreeRoot(mergeBlock));
  const mergeExecutionHash = toHexString(mergeBlock.body.executionPayload.blockHash);
  const mergePowHash = toHexString(mergeBlock.body.executionPayload.parentHash);
  chain.logger.info(POS_PANDA_MERGE_TRANSITION_BANNER);
  chain.logger.info("Execution transitioning from PoW to PoS!!!");
  chain.logger.info("Importing block referencing terminal PoW block", {
    blockHash: mergeBlockHash,
    executionHash: mergeExecutionHash,
    powHash: mergePowHash,
  });
}
