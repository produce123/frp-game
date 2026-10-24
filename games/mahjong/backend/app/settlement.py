"""纯分数结算服务。

calculate_* 只产生流水，不修改玩家；apply_deltas 是唯一状态写入口。
"""

from dataclasses import dataclass
from typing import Optional

from app.models.game import GamePlayer


def _is_integer(value) -> bool:
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


@dataclass(frozen=True)
class SettlementResult:
    deltas: tuple[dict, ...]
    total_won: int = 0

    def as_list(self) -> list[dict]:
        return [dict(delta) for delta in self.deltas]


class SettlementService:
    def calculate_lotus_win(
        self, player_count: int, winner_index: int, base_fan: int,
        winner_is_dealer: bool, self_draw_style: bool,
        payer_index: Optional[int] = None,
        dealer_index: Optional[int] = None,
        discarder_index: Optional[int] = None,
        equal_payment: bool = False,
    ) -> SettlementResult:
        """莲花麻将收付表：未胡三家按身份支付，普通点炮者的那一笔翻倍。

        equal_payment=True 用于天胡/地胡（10 番）的平收：三家等额各付
        `底分 × base_fan`，不计庄家 ×2、不计点炮者 ×2。
        """
        h = 100 * base_fan
        if equal_payment:
            dealer_pay, non_dealer_pay = h, h
        elif not winner_is_dealer and not self_draw_style:
            dealer_pay, non_dealer_pay = 2 * h, h
        elif winner_is_dealer and not self_draw_style:
            dealer_pay, non_dealer_pay = 0, 2 * h
        elif not winner_is_dealer:
            dealer_pay, non_dealer_pay = 4 * h, 2 * h
        else:
            dealer_pay, non_dealer_pay = 0, 4 * h
        payers = [payer_index] if _is_integer(payer_index) else [
            index for index in range(player_count) if index != winner_index
        ]
        def payment_for(payer: int) -> int:
            base_payment = dealer_pay if payer == dealer_index else non_dealer_pay
            if equal_payment or self_draw_style or payer != discarder_index:
                return base_payment
            return base_payment * 2

        deltas = [{'playerIndex': winner_index,
                   'amount': sum(payment_for(payer) for payer in payers)}]
        deltas.extend(
            {'playerIndex': payer,
             'amount': -payment_for(payer)}
            for payer in payers
        )
        clean = tuple(delta for delta in deltas if delta['amount'])
        return SettlementResult(clean, total_won=sum(
            delta['amount'] for delta in clean if delta['amount'] > 0
        ))

    def calculate_kong(
        self,
        player_count: int,
        kong_player_index: int,
        type_: str,
        base_score: int,
        from_index: Optional[int] = None,
    ) -> SettlementResult:
        payers = [from_index] if type_ == 'discard' else [
            i for i in range(player_count) if i != kong_player_index
        ]
        payment = base_score * 2 if type_ == 'concealed' else base_score
        valid_payers = [
            payer for payer in payers
            if _is_integer(payer) and payer != kong_player_index
        ]
        deltas = (
            {'playerIndex': kong_player_index, 'amount': payment * len(valid_payers)},
            *(
                {'playerIndex': payer, 'amount': -payment}
                for payer in valid_payers
            ),
        )
        return SettlementResult(tuple(d for d in deltas if d['amount'] != 0))

    def calculate_follow_dealer(
        self,
        player_count: int,
        dealer_index: int,
        base_score: int,
    ) -> SettlementResult:
        """跟庄：庄家首弃后三家各出一张同牌，庄家向其他三家各付一个底分。"""
        deltas = (
            {'playerIndex': dealer_index, 'amount': -base_score * 3},
            *(
                {'playerIndex': i, 'amount': base_score}
                for i in range(player_count) if i != dealer_index
            ),
        )
        return SettlementResult(tuple(d for d in deltas if d['amount'] != 0))

    def calculate_win(
        self,
        player_count: int,
        winner_index: int,
        points: int,
        payer_index: Optional[int] = None,
        dealer_index: Optional[int] = None,
    ) -> SettlementResult:
        # 广麻已取消庄家倍率（2026-09 用户定案）：所有付分者同额支付；
        # dealer_index 参数仅为兼容调用方保留。
        payers = [payer_index] if _is_integer(payer_index) else [
            i for i in range(player_count) if i != winner_index
        ]
        amounts = [points for _ in payers]
        total_won = sum(amounts)
        deltas = (
            {'playerIndex': winner_index, 'amount': total_won},
            *(
                {'playerIndex': payer, 'amount': -amount}
                for payer, amount in zip(payers, amounts)
            ),
        )
        return SettlementResult(
            tuple(delta for delta in deltas if delta['amount'] != 0),
            total_won=total_won,
        )

    @staticmethod
    def apply_deltas(players: list[GamePlayer], deltas: tuple[dict, ...] | list[dict]) -> None:
        for delta in deltas:
            players[delta['playerIndex']].score += delta['amount']


settlement_service = SettlementService()
