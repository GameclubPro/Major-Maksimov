export const PHOTO_RECOMPRESSION_VERSION = 'native-recompression-v2' as const;

export type PhotoRecompressionProof = Readonly<{
  version: typeof PHOTO_RECOMPRESSION_VERSION;
  originalHash: string;
  currentHash: string;
}>;
