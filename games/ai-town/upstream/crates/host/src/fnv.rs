//! FNV-1a：检测内容变化与操作去重用的非加密哈希，全 host 只有这一份实现。

pub const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

/// 从 `seed` 继续累加；分段哈希时把上一段的结果当下一段的 seed。
pub fn fnv1a(bytes: &[u8], seed: u64) -> u64 {
    bytes
        .iter()
        .fold(seed, |h, b| (h ^ u64::from(*b)).wrapping_mul(FNV_PRIME))
}
