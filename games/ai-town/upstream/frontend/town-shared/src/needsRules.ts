import source from '../../../config/needs_rules.json'
import type { NeedBand } from './protocol'

export const NEED_BANDS: Record<
  NeedBand,
  { class: string; label: string; severity: number; fullness: string; energy: string }
> = source.bands
