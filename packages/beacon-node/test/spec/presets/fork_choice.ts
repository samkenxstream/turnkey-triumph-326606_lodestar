import {expect} from "chai";
import {BeaconStateAllForks, isBellatrixStateType} from "@lodestar/state-transition";
import {InputType} from "@lodestar/spec-test-util";
import {toHexString} from "@chainsafe/ssz";
import {CheckpointWithHex, ForkChoice} from "@lodestar/fork-choice";
import {phase0, allForks, bellatrix, ssz, RootHex} from "@lodestar/types";
import {bnToNum} from "@lodestar/utils";
import {createIBeaconConfig} from "@lodestar/config";
import {BeaconChain, ChainEvent} from "../../../src/chain/index.js";
import {createCachedBeaconStateTest} from "../../utils/cachedBeaconState.js";
import {testLogger} from "../../utils/logger.js";
import {getConfig} from "../utils/getConfig.js";
import {TestRunnerFn} from "../utils/types.js";
import {IEth1ForBlockProduction} from "../../../src/eth1/index.js";
import {ExecutionEngineMock} from "../../../src/execution/index.js";
import {defaultChainOptions} from "../../../src/chain/options.js";
import {getStubbedBeaconDb} from "../../utils/mocks/db.js";
import {ClockStopped} from "../../utils/mocks/clock.js";
import {ZERO_HASH_HEX} from "../../../src/constants/constants.js";
import {PowMergeBlock} from "../../../src/eth1/interface.js";
import {assertCorrectProgressiveBalances} from "../config.js";

/* eslint-disable @typescript-eslint/naming-convention */

/* eslint-disable @typescript-eslint/naming-convention */

const ANCHOR_STATE_FILE_NAME = "anchor_state";
const ANCHOR_BLOCK_FILE_NAME = "anchor_block";
const BLOCK_FILE_NAME = "^(block)_([0-9a-zA-Z]+)$";
const POW_BLOCK_FILE_NAME = "^(pow_block)_([0-9a-zA-Z]+)$";
const ATTESTATION_FILE_NAME = "^(attestation)_([0-9a-zA-Z])+$";
const ATTESTER_SLASHING_FILE_NAME = "^(attester_slashing)_([0-9a-zA-Z])+$";

const logger = testLogger("spec-test");

export const forkChoiceTest: TestRunnerFn<ForkChoiceTestCase, void> = (fork) => {
  return {
    testFunction: async (testcase) => {
      const {steps, anchorState} = testcase;
      const currentSlot = anchorState.slot;
      const config = getConfig(fork);
      const state = createCachedBeaconStateTest(anchorState, config);

      /** This is to track test's tickTime to be used in proposer boost */
      let tickTime = 0;
      const clock = new ClockStopped(currentSlot);
      const eth1 = new Eth1ForBlockProductionMock();
      const executionEngine = new ExecutionEngineMock({
        genesisBlockHash: isBellatrixStateType(anchorState)
          ? toHexString(anchorState.latestExecutionPayloadHeader.blockHash)
          : ZERO_HASH_HEX,
      });

      const chain = new BeaconChain(
        {
          ...defaultChainOptions,
          // Do not start workers
          blsVerifyAllMainThread: true,
          // Do not run any archiver tasks
          disableArchiveOnCheckpoint: true,
          // Since the tests have deep-reorgs attested data is not available often printing lots of error logs.
          // While this function is only called for head blocks, best to disable.
          disableLightClientServerOnImportBlockHead: true,
          // No need to log BlockErrors, the spec test runner will only log them if not not expected
          // Otherwise spec tests logs get cluttered with expected errors
          disableOnBlockError: true,
          // PrepareNextSlot scheduler is used to precompute epoch transition and prepare for the next payload
          // we don't use these in fork choice spec tests
          disablePrepareNextSlot: true,
          assertCorrectProgressiveBalances,
          computeUnrealized: false,
        },
        {
          config: createIBeaconConfig(config, state.genesisValidatorsRoot),
          db: getStubbedBeaconDb(),
          logger,
          clock,
          metrics: null,
          anchorState,
          eth1,
          executionEngine,
          executionBuilder: undefined,
        }
      );

      const stepsLen = steps.length;
      logger.debug("Fork choice test", {steps: stepsLen});

      try {
        for (const [i, step] of steps.entries()) {
          if (isTick(step)) {
            tickTime = bnToNum(step.tick);
            const currentSlot = Math.floor(tickTime / config.SECONDS_PER_SLOT);
            logger.debug(`Step ${i}/${stepsLen} tick`, {currentSlot, valid: Boolean(step.valid), time: tickTime});
            chain.emitter.emit(ChainEvent.clockSlot, currentSlot);
            clock.setSlot(currentSlot);
          }

          // attestation step
          else if (isAttestation(step)) {
            logger.debug(`Step ${i}/${stepsLen} attestation`, {root: step.attestation, valid: Boolean(step.valid)});
            const attestation = testcase.attestations.get(step.attestation);
            if (!attestation) throw Error(`No attestation ${step.attestation}`);
            const headState = chain.getHeadState();
            chain.forkChoice.onAttestation(headState.epochCtx.getIndexedAttestation(attestation));
          }

          // block step
          else if (isBlock(step)) {
            const isValid = Boolean(step.valid ?? true);
            const signedBlock = testcase.blocks.get(step.block);
            if (!signedBlock) {
              throw Error(`No block ${step.block}`);
            }

            // Log the BeaconBlock root instead of the SignedBeaconBlock root, forkchoice references BeaconBlock roots
            const blockRoot = config
              .getForkTypes(signedBlock.message.slot)
              .BeaconBlock.hashTreeRoot(signedBlock.message);
            logger.debug(`Step ${i}/${stepsLen} block`, {
              slot: signedBlock.message.slot,
              root: toHexString(blockRoot),
              parentRoot: toHexString(signedBlock.message.parentRoot),
              isValid,
            });

            try {
              await chain.processBlock(signedBlock, {seenTimestampSec: tickTime});
              if (!isValid) throw Error("Expect error since this is a negative test");
            } catch (e) {
              if (isValid) throw e;
            }
          }

          // **on_merge_block execution**
          // Adds PowBlock data which is required for executing on_block(store, block).
          // The file is located in the same folder (see below). PowBlocks should be used as return values for
          // get_pow_block(hash: Hash32) -> PowBlock function if hashes match.
          else if (isPowBlock(step)) {
            const powBlock = testcase.powBlocks.get(step.pow_block);
            if (!powBlock) throw Error(`pow_block ${step.pow_block} not found`);
            logger.debug(`Step ${i}/${stepsLen} pow_block`, {
              blockHash: toHexString(powBlock.blockHash),
              parentHash: toHexString(powBlock.parentHash),
            });
            // Register PowBlock for `get_pow_block(hash: Hash32)` calls in verifyBlock
            eth1.addPowBlock(powBlock);
            // Register PowBlock to allow validation in execution engine
            executionEngine.addPowBlock(powBlock);
          }

          // checks step
          else if (isCheck(step)) {
            logger.debug(`Step ${i}/${stepsLen} check`);

            // Forkchoice head is computed lazily only on request
            const head = chain.forkChoice.updateHead();
            const proposerBootRoot = (chain.forkChoice as ForkChoice).getProposerBoostRoot();

            if (step.checks.head !== undefined) {
              expect(head.slot).to.be.equal(bnToNum(step.checks.head.slot), `Invalid head slot at step ${i}`);
              expect(head.blockRoot).to.be.equal(step.checks.head.root, `Invalid head root at step ${i}`);
            }
            if (step.checks.proposer_boost_root !== undefined) {
              expect(proposerBootRoot).to.be.equal(
                step.checks.proposer_boost_root,
                `Invalid proposer boost root at step ${i}`
              );
            }
            // time in spec mapped to Slot in our forkchoice implementation.
            // Compare in slots because proposer boost steps doesn't always come on
            // slot boundary.
            if (step.checks.time !== undefined && step.checks.time > 0)
              expect(chain.forkChoice.getTime()).to.be.equal(
                Math.floor(bnToNum(step.checks.time) / config.SECONDS_PER_SLOT),
                `Invalid forkchoice time at step ${i}`
              );
            if (step.checks.justified_checkpoint) {
              expect(toSpecTestCheckpoint(chain.forkChoice.getJustifiedCheckpoint())).to.be.deep.equal(
                step.checks.justified_checkpoint,
                `Invalid justified checkpoint at step ${i}`
              );
            }
            if (step.checks.finalized_checkpoint) {
              expect(toSpecTestCheckpoint(chain.forkChoice.getFinalizedCheckpoint())).to.be.deep.equal(
                step.checks.finalized_checkpoint,
                `Invalid finalized checkpoint at step ${i}`
              );
            }
            if (step.checks.best_justified_checkpoint) {
              expect(
                toSpecTestCheckpoint((chain.forkChoice as ForkChoice).getBestJustifiedCheckpoint())
              ).to.be.deep.equal(
                step.checks.best_justified_checkpoint,
                `Invalid best justified checkpoint at step ${i}`
              );
            }
          }

          // None of the above
          else {
            throw Error(`Unknown step ${i}/${stepsLen}: ${JSON.stringify(Object.keys(step))}`);
          }
        }
      } finally {
        await chain.close();
      }
    },

    options: {
      inputTypes: {
        meta: InputType.YAML,
        steps: InputType.YAML,
      },
      sszTypes: {
        [ANCHOR_STATE_FILE_NAME]: ssz[fork].BeaconState,
        [ANCHOR_BLOCK_FILE_NAME]: ssz[fork].BeaconBlock,
        [BLOCK_FILE_NAME]: ssz[fork].SignedBeaconBlock,
        [POW_BLOCK_FILE_NAME]: ssz.bellatrix.PowBlock,
        [ATTESTATION_FILE_NAME]: ssz.phase0.Attestation,
        [ATTESTER_SLASHING_FILE_NAME]: ssz.phase0.AttesterSlashing,
      },
      mapToTestCase: (t: Record<string, any>) => {
        // t has input file name as key
        const blocks = new Map<string, allForks.SignedBeaconBlock>();
        const powBlocks = new Map<string, bellatrix.PowBlock>();
        const attestations = new Map<string, phase0.Attestation>();
        for (const key in t) {
          const blockMatch = key.match(BLOCK_FILE_NAME);
          if (blockMatch) {
            blocks.set(key, t[key]);
          }
          const powBlockMatch = key.match(POW_BLOCK_FILE_NAME);
          if (powBlockMatch) {
            powBlocks.set(key, t[key]);
          }
          const attMatch = key.match(ATTESTATION_FILE_NAME);
          if (attMatch) {
            attestations.set(key, t[key]);
          }
        }
        return {
          meta: t["meta"] as ForkChoiceTestCase["meta"],
          anchorState: t[ANCHOR_STATE_FILE_NAME] as ForkChoiceTestCase["anchorState"],
          anchorBlock: t[ANCHOR_BLOCK_FILE_NAME] as ForkChoiceTestCase["anchorBlock"],
          steps: t["steps"] as ForkChoiceTestCase["steps"],
          blocks,
          powBlocks,
          attestations,
        };
      },
      timeout: 10000,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      expectFunc: () => {},
    },
  };
};

function toSpecTestCheckpoint(checkpoint: CheckpointWithHex): SpecTestCheckpoint {
  return {
    epoch: BigInt(checkpoint.epoch),
    root: checkpoint.rootHex,
  };
}

type Step = OnTick | OnAttestation | OnBlock | OnPowBlock | Checks;

type SpecTestCheckpoint = {epoch: bigint; root: string};

// This test executes steps in sequence. There may be multiple items of the following types:
// on_tick execution step

type OnTick = {
  /** to execute `on_tick(store, time)` */
  tick: bigint;
  /** optional, default to `true`. */
  valid?: number;
};

type OnAttestation = {
  /** the name of the `attestation_<32-byte-root>.ssz_snappy` file. To execute `on_attestation(store, attestation)` */
  attestation: string;
  /** optional, default to `true`. */
  valid?: number;
};

type OnBlock = {
  /** the name of the `block_<32-byte-root>.ssz_snappy` file. To execute `on_block(store, block)` */
  block: string;
  /** optional, default to `true`. */
  valid?: number;
};

type OnPowBlock = {
  /**
   * the name of the `pow_block_<32-byte-root>.ssz_snappy` file. To
   * execute `on_pow_block(store, block)`
   */
  pow_block: string;
};

type Checks = {
  /** Value in the ForkChoice store to verify it's correct after being mutated by another step */
  checks: {
    head?: {
      slot: bigint;
      root: string;
    };
    time?: bigint;
    justified_checkpoint?: SpecTestCheckpoint;
    finalized_checkpoint?: SpecTestCheckpoint;
    best_justified_checkpoint?: SpecTestCheckpoint;
    proposer_boost_root?: RootHex;
  };
};

type ForkChoiceTestCase = {
  meta?: {
    description?: string;
    bls_setting: bigint;
  };
  anchorState: BeaconStateAllForks;
  anchorBlock: allForks.BeaconBlock;
  steps: Step[];
  blocks: Map<string, allForks.SignedBeaconBlock>;
  powBlocks: Map<string, bellatrix.PowBlock>;
  attestations: Map<string, phase0.Attestation>;
};

function isTick(step: Step): step is OnTick {
  return (step as OnTick).tick >= 0;
}

function isAttestation(step: Step): step is OnAttestation {
  return typeof (step as OnAttestation).attestation === "string";
}

function isBlock(step: Step): step is OnBlock {
  return typeof (step as OnBlock).block === "string";
}

function isPowBlock(step: Step): step is OnPowBlock {
  return typeof (step as OnPowBlock).pow_block === "string";
}

function isCheck(step: Step): step is Checks {
  return typeof (step as Checks).checks === "object";
}

class Eth1ForBlockProductionMock implements IEth1ForBlockProduction {
  private items = new Map<string, PowMergeBlock>();
  async getEth1DataAndDeposits(): Promise<never> {
    throw Error("Not implemented");
  }

  getTerminalPowBlock(): never {
    throw Error("Not implemented");
  }

  mergeCompleted(): never {
    throw Error("Not implemented");
  }

  async getPowBlock(powBlockHash: string): Promise<PowMergeBlock | null> {
    return this.items.get(powBlockHash) ?? null;
  }

  addPowBlock(powBlock: bellatrix.PowBlock): void {
    this.items.set(toHexString(powBlock.blockHash), {
      // not used by verifyBlock()
      number: 0,
      blockHash: toHexString(powBlock.blockHash),
      parentHash: toHexString(powBlock.parentHash),
      totalDifficulty: powBlock.totalDifficulty,
    });
  }
}
