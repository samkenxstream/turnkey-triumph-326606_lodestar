import {EffectiveBalanceIncrements} from "@chainsafe/lodestar-beacon-state-transition";
import {phase0, Slot, RootHex} from "@chainsafe/lodestar-types";
import {toHexString} from "@chainsafe/ssz";

/**
 * Stores checkpoints in a hybrid format:
 * - Original checkpoint for fast consumption in Lodestar's side
 * - Root in string hex for fast comparisions inside the fork-choice
 */
export type CheckpointWithHex = phase0.Checkpoint & {rootHex: RootHex};

/**
 * Approximates the `Store` in "Ethereum Consensus -- Beacon Chain Fork Choice":
 *
 * https://github.com/ethereum/consensus-specs/blob/v1.1.10/specs/phase0/fork-choice.md#store
 *
 * ## Detail
 *
 * This is only an approximation for two reasons:
 *
 * - The actual block DAG in `ProtoArray`.
 * - `time` is represented using `Slot` instead of UNIX epoch `u64`.
 */
export interface IForkChoiceStore {
  currentSlot: Slot;
  finalizedCheckpoint: CheckpointWithHex;
  justified: CheckpointWithBalances;
  bestJustified: CheckpointWithBalances;
}

export type CheckpointWithBalances = {
  checkpoint: CheckpointWithHex;
  balances: EffectiveBalanceIncrements;
};

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/member-ordering */

/**
 * IForkChoiceStore implementer which emits forkChoice events on updated justified and finalized checkpoints.
 */
export class ForkChoiceStore implements IForkChoiceStore {
  bestJustified: CheckpointWithBalances;
  private _justified: CheckpointWithBalances;
  private _finalizedCheckpoint: CheckpointWithHex;

  constructor(
    public currentSlot: Slot,
    justifiedCheckpoint: phase0.Checkpoint,
    justifiedBalances: EffectiveBalanceIncrements,
    finalizedCheckpoint: phase0.Checkpoint,
    private readonly events?: {
      onJustified: (cp: CheckpointWithHex) => void;
      onFinalized: (cp: CheckpointWithHex) => void;
    }
  ) {
    this._justified = {
      checkpoint: toCheckpointWithHex(justifiedCheckpoint),
      balances: justifiedBalances,
    };
    this._finalizedCheckpoint = toCheckpointWithHex(finalizedCheckpoint);
    this.bestJustified = this._justified;
  }

  get justified(): CheckpointWithBalances {
    return this._justified;
  }
  set justified(checkpointWithBalances: CheckpointWithBalances) {
    this._justified = checkpointWithBalances;
    this.events?.onJustified(checkpointWithBalances.checkpoint);
  }

  get finalizedCheckpoint(): CheckpointWithHex {
    return this._finalizedCheckpoint;
  }
  set finalizedCheckpoint(checkpoint: CheckpointWithHex) {
    const cp = toCheckpointWithHex(checkpoint);
    this._finalizedCheckpoint = cp;
    this.events?.onFinalized(cp);
  }
}

export function toCheckpointWithHex(checkpoint: phase0.Checkpoint): CheckpointWithHex {
  // `valueOf` coerses the checkpoint, which may be tree-backed, into a javascript object
  // See https://github.com/ChainSafe/lodestar/issues/2258
  const root = checkpoint.root;
  return {
    epoch: checkpoint.epoch,
    root,
    rootHex: toHexString(root),
  };
}

export function equalCheckpointWithHex(a: CheckpointWithHex, b: CheckpointWithHex): boolean {
  return a.epoch === b.epoch && a.rootHex === b.rootHex;
}
