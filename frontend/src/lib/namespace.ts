// The Hedera-native wallet namespace, on its own.
//
// It is the string 'hedera' and nothing more — but importing it from
// `@/lib/appkit` drags in HederaAdapter and, behind it, the whole Hedera SDK.
// That is ~1.5MB of first-load JS for any page that only wanted to know which
// namespace to ask AppKit about. The dealer page went from 239kB to 1.73MB on
// exactly that import.
//
// `appkit.ts` asserts this matches the package's own constant at module load,
// so the two cannot drift apart quietly.
import type { ChainNamespace } from '@reown/appkit-common';

export const HEDERA_NAMESPACE = 'hedera' as ChainNamespace;
