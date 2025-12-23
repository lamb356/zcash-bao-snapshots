/**
 * Zcash data structure type definitions.
 *
 * These types represent the data structures used by zcashd and lightwalletd
 * for tree states and compact blocks as defined in ZIP-307 and the zcashd RPC API.
 *
 * @packageDocumentation
 */

/**
 * Hexadecimal string representation.
 * Used for hashes, serialized trees, and other binary data in RPC responses.
 */
export type HexString = string;

/**
 * Block hash in reversed hex format (as returned by zcashd).
 */
export type BlockHash = HexString;

/**
 * Transaction ID in reversed hex format.
 */
export type TxId = HexString;

/**
 * Sapling note commitment tree state.
 * Contains the merkle tree of note commitments up to a specific block.
 */
export interface SaplingTreeState {
  /**
   * Merkle tree root hash (32 bytes as hex).
   * This is the anchor that can be used for Sapling spend proofs.
   */
  readonly finalRoot: HexString;

  /**
   * Serialized incremental merkle tree state.
   * Can be used to continue building the tree from this point.
   */
  readonly tree: HexString;
}

/**
 * Orchard note commitment tree state.
 * Contains the merkle tree of note commitments up to a specific block.
 */
export interface OrchardTreeState {
  /**
   * Merkle tree root hash (32 bytes as hex).
   * This is the anchor that can be used for Orchard spend proofs.
   */
  readonly finalRoot: HexString;

  /**
   * Serialized incremental merkle tree state.
   * Can be used to continue building the tree from this point.
   */
  readonly tree: HexString;
}

/**
 * Complete tree state response from z_gettreestate RPC.
 * Contains both Sapling and Orchard commitment trees at a specific block.
 */
export interface TreeState {
  /**
   * Block hash this tree state corresponds to.
   */
  readonly hash: BlockHash;

  /**
   * Block height this tree state corresponds to.
   */
  readonly height: number;

  /**
   * Unix timestamp of the block.
   */
  readonly time: number;

  /**
   * Sapling note commitment tree state.
   * Present for blocks at or after Sapling activation (block 419200 on mainnet).
   */
  readonly sapling?: SaplingTreeState;

  /**
   * Orchard note commitment tree state.
   * Present for blocks at or after NU5 activation (block 1687104 on mainnet).
   */
  readonly orchard?: OrchardTreeState;
}

/**
 * Compact transaction output for Sapling.
 * As defined in ZIP-307 for lightwalletd compact blocks.
 */
export interface CompactSaplingOutput {
  /**
   * Note ciphertext component (first 52 bytes of enc_ciphertext).
   */
  readonly cmu: Uint8Array;

  /**
   * Ephemeral public key.
   */
  readonly ephemeralKey: Uint8Array;

  /**
   * First 52 bytes of the encrypted note ciphertext.
   */
  readonly ciphertext: Uint8Array;
}

/**
 * Compact transaction output for Orchard.
 * As defined in ZIP-307 for lightwalletd compact blocks.
 */
export interface CompactOrchardAction {
  /**
   * Note commitment.
   */
  readonly cmx: Uint8Array;

  /**
   * Ephemeral public key.
   */
  readonly ephemeralKey: Uint8Array;

  /**
   * First 52 bytes of the encrypted note ciphertext.
   */
  readonly ciphertext: Uint8Array;

  /**
   * Nullifier for the spent note.
   */
  readonly nullifier: Uint8Array;
}

/**
 * Compact transaction as defined in ZIP-307.
 * Contains only the data needed for wallet scanning.
 */
export interface CompactTransaction {
  /**
   * Index of this transaction within the block.
   */
  readonly index: number;

  /**
   * Transaction hash.
   */
  readonly hash: Uint8Array;

  /**
   * Transaction fee in zatoshis (optional, may not be present in older blocks).
   */
  readonly fee?: number;

  /**
   * Sapling outputs in this transaction.
   */
  readonly outputs: readonly CompactSaplingOutput[];

  /**
   * Orchard actions in this transaction.
   */
  readonly actions: readonly CompactOrchardAction[];
}

/**
 * Compact block as defined in ZIP-307.
 * Contains minimal data needed for wallet scanning.
 */
export interface CompactBlock {
  /**
   * Block height.
   */
  readonly height: number;

  /**
   * Block hash.
   */
  readonly hash: Uint8Array;

  /**
   * Previous block hash.
   */
  readonly prevHash: Uint8Array;

  /**
   * Block timestamp.
   */
  readonly time: number;

  /**
   * Block header (optional, 1487 bytes if present).
   */
  readonly header?: Uint8Array;

  /**
   * Compact transactions with shielded data.
   */
  readonly vtx: readonly CompactTransaction[];

  /**
   * Sapling commitment tree size after this block.
   */
  readonly saplingCommitmentTreeSize?: number;

  /**
   * Orchard commitment tree size after this block.
   */
  readonly orchardCommitmentTreeSize?: number;

  /**
   * Chain metadata (optional).
   */
  readonly chainMetadata?: ChainMetadata;
}

/**
 * Chain metadata included in compact blocks.
 */
export interface ChainMetadata {
  /**
   * Sapling commitment tree size.
   */
  readonly saplingCommitmentTreeSize: number;

  /**
   * Orchard commitment tree size.
   */
  readonly orchardCommitmentTreeSize: number;
}

/**
 * Block range for fetching compact blocks.
 */
export interface BlockRange {
  /**
   * Start height (inclusive).
   */
  readonly start: number;

  /**
   * End height (inclusive).
   */
  readonly end: number;
}

/**
 * Network types supported by Zcash.
 */
export type ZcashNetwork = 'mainnet' | 'testnet' | 'regtest';

/**
 * Network-specific constants.
 */
export interface NetworkConstants {
  /**
   * Network identifier.
   */
  readonly network: ZcashNetwork;

  /**
   * Sapling activation height.
   */
  readonly saplingActivationHeight: number;

  /**
   * NU5 (Orchard) activation height.
   */
  readonly nu5ActivationHeight: number;

  /**
   * Default zcashd RPC port.
   */
  readonly defaultRpcPort: number;

  /**
   * Default lightwalletd gRPC port.
   */
  readonly defaultLightwalletdPort: number;

  /**
   * Human-readable coin prefix (zs for mainnet, ztestsapling for testnet).
   */
  readonly coinPrefix: string;
}

/**
 * Network constants for mainnet.
 */
export const MAINNET: NetworkConstants = {
  network: 'mainnet',
  saplingActivationHeight: 419200,
  nu5ActivationHeight: 1687104,
  defaultRpcPort: 8232,
  defaultLightwalletdPort: 9067,
  coinPrefix: 'zs',
} as const;

/**
 * Network constants for testnet.
 */
export const TESTNET: NetworkConstants = {
  network: 'testnet',
  saplingActivationHeight: 280000,
  nu5ActivationHeight: 1842420,
  defaultRpcPort: 18232,
  defaultLightwalletdPort: 19067,
  coinPrefix: 'ztestsapling',
} as const;

/**
 * Network constants for regtest.
 */
export const REGTEST: NetworkConstants = {
  network: 'regtest',
  saplingActivationHeight: 1,
  nu5ActivationHeight: 1,
  defaultRpcPort: 18232,
  defaultLightwalletdPort: 19067,
  coinPrefix: 'zregtestsapling',
} as const;

/**
 * Get network constants by network name.
 */
export function getNetworkConstants(network: ZcashNetwork): NetworkConstants {
  switch (network) {
    case 'mainnet':
      return MAINNET;
    case 'testnet':
      return TESTNET;
    case 'regtest':
      return REGTEST;
  }
}
