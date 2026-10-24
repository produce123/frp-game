"""牌桌自由台词清洗与动作兜底台词。"""

import re

from app.llm.speech_policy import compact_speech_text

PUBLIC_ACTION_RE = re.compile(
    r'(上家|对家|下家)(?:刚才|刚刚|刚|已经|又|也)?(暗杠|明杠|补杠|杠|碰|吃)(?:了|过|成)?')
PUBLIC_DISCARD_RE = re.compile(
    r'(上家|对家|下家)(?:刚才|刚刚|刚)?(?:打出|打了|打的|出了)(?:一张)?'
    r'([1-9][万筒条]|东风|南风|西风|北风|红中|发财|白板)?')

DECISION_SPEECH_LINES = {
    'discard': {
        '激进': ('这张不要了。', '先打出去。', '这一张走。'),
        '稳健': ('这张先走。', '先打这一张。', '按牌路来。'),
        '话痨': ('先把这张放出去。', '这一张先打掉。', '轮到我出牌啦。'),
        '高冷': ('打。', '这张。', '出牌。'),
    },
    'gang': {
        '激进': ('大明杠，开！', '这杠我拿了！', '直接杠！'),
        '稳健': ('大明杠。', '这杠可以开。', '顺势开杠。'),
        '话痨': ('这张正好大明杠！', '来得巧，我杠了！', '四张齐了，开杠！'),
        '高冷': ('杠。', '大明杠。', '开杠。'),
    },
    'peng': {
        '激进': ('碰！', '这张我要了！', '直接碰！'),
        '稳健': ('碰一个。', '这张可以碰。', '顺势碰。'),
        '话痨': ('来得正好，我碰！', '这张我可要碰啦！', '凑齐了，碰一个！'),
        '高冷': ('碰。', '收下。', '碰了。'),
    },
    'chi': {
        '激进': ('直接吃！', '这张我吃了！', '顺手拿下！'),
        '稳健': ('顺手吃了。', '这张可以吃。', '吃一组。'),
        '话痨': ('刚好连上，我吃啦！', '这张来得正合适！', '顺子齐了，吃一个！'),
        '高冷': ('吃。', '收下。', '吃了。'),
    },
    'pass': {
        '激进': ('先放你一手。', '这次不要。', '继续来。'),
        '稳健': ('先看看。', '这次先过。', '不急这一手。'),
        '话痨': ('这张我先不要啦。', '你们继续，我看看。', '先过，后面再说！'),
        '高冷': ('过。', '不要。', '继续。'),
    },
    'added-kong': {
        '激进': ('补杠，开！', '这张补上！', '补杠拿下！'),
        '稳健': ('补杠。', '顺势补杠。', '这一张补上。'),
        '话痨': ('第四张到了，补杠！', '刚好补上这一杠！', '等到了，补杠啦！'),
        '高冷': ('补杠。', '补上。', '杠。'),
    },
    'concealed-kong': {
        '激进': ('暗杠，开！', '四张在手，杠！', '直接暗杠！'),
        '稳健': ('暗杠。', '这手开暗杠。', '暗杠正合适。'),
        '话痨': ('四张都在手，暗杠！', '藏得好好的，开杠啦！', '这一组正好暗杠！'),
        '高冷': ('暗杠。', '杠。', '开。'),
    },
    'wind-kong': {
        '激进': ('乱风杠，开！', '四风齐了！', '风杠拿下！'),
        '稳健': ('乱风杠。', '四风成杠。', '这一手风杠。'),
        '话痨': ('东南西北齐了，风杠！', '四风都到手啦！', '这手正好乱风杠！'),
        '高冷': ('风杠。', '四风齐。', '杠。'),
    },
    'win': {
        '激进': ('拿下！',), '稳健': ('收下了。',), '话痨': ('这手我拿下啦！',), '高冷': ('胡。',),
    },
}

REASONING_STATUS_LINES = {
    '激进': ('让我算算怎么打。', '这手得想清楚。', '先别急，我算一下。'),
    '稳健': ('让我想想怎么打。', '这手要仔细看看。', '容我想一想。'),
    '话痨': ('等等，让我好好想想。', '这手有点难，我算算。', '我得认真琢磨一下。'),
    '高冷': ('稍等。', '容我想想。', '这手要算。'),
}

SAFE_REASONING_STAGES = (
    '正在观察公开牌局',
    '正在整理规则约束',
    '正在比较可行动作',
    '正在评估攻守节奏',
    '正在复核最终选择',
)


def reasoning_status_speech(style: str, sequence: int = 0) -> str:
    variants = REASONING_STATUS_LINES.get(style, REASONING_STATUS_LINES['稳健'])
    return variants[abs(sequence) % len(variants)]


def safe_reasoning_status(sequence: int) -> str:
    """只按推理块序号生成进度，不接触供应商原始思考内容。"""
    count = max(1, int(sequence))
    return f'思考中 · {SAFE_REASONING_STAGES[(count - 1) % len(SAFE_REASONING_STAGES)]}'


def decision_speech(action: dict, style: str, sequence: int = 0) -> str:
    kind = action.get('kind', 'discard')
    styles = DECISION_SPEECH_LINES.get(kind, DECISION_SPEECH_LINES['discard'])
    variants = styles.get(style, styles['稳健'])
    return variants[abs(sequence) % len(variants)]


def resolve_decision_speech(message: str, action: dict,
                            style: str, sequence: int = 0,
                            facts: dict | None = None) -> str:
    """保留合规烟雾弹；仅缺失或幕后内容回退程序台词。"""
    compact = compact_speech_text(message)
    facts = facts or {}
    denies_dealer = bool(re.search(r'我(?:可|并)?不是庄家|我非庄家|我不坐庄', compact))
    claims_dealer = bool(re.search(
        r'本庄|庄家(?:是|就是)我|我(?:可是|就是|是|当|来当|在当|要当|坐|来坐|在坐)庄家?|这把我坐庄|我是东家',
        compact))
    is_dealer = facts.get('isDealer')
    contradicts_dealer = (is_dealer is False and claims_dealer and not denies_dealer) \
        or (is_dealer is True and denies_dealer)
    contradicts_public_action = False
    public_meld_types = facts.get('publicMeldTypes') or {}
    for seat, claim in PUBLIC_ACTION_RE.findall(compact):
        types = public_meld_types.get(seat)
        if types is None:
            continue
        supported = ('chi' in types) if claim == '吃' else \
            ('peng' in types) if claim == '碰' else \
            ('angang' in types) if claim == '暗杠' else \
            ('gang' in types) if claim in ('明杠', '补杠') else \
            any(type_ in ('gang', 'angang') for type_ in types)
        if not supported:
            contradicts_public_action = True
            break
    contradicts_current_discard = False
    current_discard = facts.get('currentDiscard')
    if current_discard:
        for from_, tile in PUBLIC_DISCARD_RE.findall(compact):
            if from_ != current_discard.get('from') \
                    or bool(tile and tile != current_discard.get('tile')):
                contradicts_current_discard = True
                break
    keep_terms = r'(?:留着|保留|留下|不打|当宝)'
    generic_keep = bool(re.search(
        rf'(?:这张|这牌|此牌).{{0,4}}{keep_terms}|{keep_terms}.{{0,4}}(?:这张|这牌|此牌)',
        compact))
    discarded_tile = facts.get('discardedTile')
    named_keep = bool(discarded_tile and re.search(
        rf'{re.escape(discarded_tile)}.{{0,4}}{keep_terms}|'
        rf'{keep_terms}.{{0,4}}{re.escape(discarded_tile)}',
        compact))
    contradicts_discard_commitment = action.get('kind') == 'discard' \
        and (generic_keep or named_keep)
    self_speech = PUBLIC_ACTION_RE.sub('', compact)
    claimed_kong_kind = 'concealed-kong' if re.search(r'暗杠', self_speech) else \
        'added-kong' if re.search(r'补杠', self_speech) else \
        'wind-kong' if re.search(r'乱风杠|风杠', self_speech) else \
        'gang' if re.search(r'大明杠|明杠', self_speech) else None
    claims_generic_kong = bool(re.search(r'我要杠|我杠了|开杠|直接杠', self_speech))
    claimed_action = 'chi' if re.search(r'吃定了|我要吃|我吃了|这牌我吃|直接吃', self_speech) else \
        'peng' if re.search(r'我要碰|我碰了|碰一个|直接碰|这牌我碰', self_speech) else \
        'gang' if claimed_kong_kind or claims_generic_kong else \
        'pass' if re.search(r'我过了|这次我过|我要过', self_speech) else None
    actual_kind = action.get('kind')
    action_matches = claimed_action is None or claimed_action == actual_kind \
        or (claimed_action == 'gang' and actual_kind in (
            'gang', 'added-kong', 'concealed-kong', 'wind-kong'))
    kong_subtype_matches = claimed_kong_kind is None or actual_kind == claimed_kong_kind
    if compact and not contradicts_dealer and not contradicts_public_action \
            and not contradicts_current_discard and not contradicts_discard_commitment \
            and action_matches and kong_subtype_matches:
        return compact
    return decision_speech(action, style, sequence)
