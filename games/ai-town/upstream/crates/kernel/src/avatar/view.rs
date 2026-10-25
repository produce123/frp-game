//! 玩家控制目标的个人视图：本人、够得着的人与道具、门口、互动与聊天。
use super::*;
use crate::interactions::Interactions;
use protocol::{
    AvatarActor, AvatarChatItem, AvatarInteraction, AvatarMode, AvatarPairItem, AvatarPropView,
    AvatarState, AvatarView, Interaction, InteractionObservation, NearbyChat, NearbyPerson,
    PortalView,
};

/// 视图里列出的最近动作回执数。
const FEEDBACK_ACTIONS: usize = 3;
/// 附身的居民没有自定外观时，地图标记用名字的第一个字和这个颜色。
const RESIDENT_COLOR: &str = "#397d60";

impl World {
    pub fn avatar_view(&self) -> AvatarView {
        self.avatar_view_for(self.player_id())
    }
    /// 指定 actor 的视图；host 给每个访客发状态时用，不依赖全局 active_actor。
    pub fn avatar_view_for(&self, actor: &str) -> AvatarView {
        let Some(map) = &self.walk_map else {
            return AvatarView::Unsupported { supported: false };
        };
        let Some(a) = self.actor(actor) else {
            return AvatarView::Empty {
                actor: (),
                supported: true,
                units: map.svg_units_per_metre,
            };
        };
        let b = Builder {
            w: self,
            a,
            reach: Reach::new(self),
        };
        let awaiting = a.possession.as_ref().is_some_and(|p| p.awaiting_arrival);
        AvatarView::Present(Box::new(AvatarState {
            actor: b.actor(awaiting),
            awaiting_arrival: awaiting,
            can_drop: b.reach.drop_station().is_some(),
            feedback: feedback(a),
            interactions: self
                .interactions
                .for_actor(&a.id)
                .into_iter()
                .map(|i| b.interaction(i))
                .collect(),
            mode: if a.possession.is_some() {
                AvatarMode::Possession
            } else {
                AvatarMode::Avatar
            },
            navigation_revision: self.topo.navigation_revision().unwrap_or(1),
            nearby: b.nearby_people(),
            nearby_chats: b.reachable_chats(),
            portals: b.nearby_portals(map),
            props: b.reachable_props(),
            reading: self
                .contents
                .readings
                .get(&a.id)
                .and_then(|reads| reads.values().last())
                .map(|r| r.content.view()),
            supported: true,
            units: map.svg_units_per_metre,
        }))
    }
}

/// 拼化身视图的各部分：世界、控制目标、这次视图共用的可达判断。
struct Builder<'a> {
    w: &'a World,
    a: &'a Actor,
    reach: Reach<'a>,
}

impl Builder<'_> {
    fn actor(&self, awaiting: bool) -> AvatarActor {
        let (w, a) = (self.w, self.a);
        let appearance = a
            .avatar
            .as_ref()
            .map(|p| p.appearance.clone())
            .unwrap_or_else(|| Appearance {
                marker: a.name.chars().take(1).collect(),
                color: RESIDENT_COLOR.into(),
                profile: None,
                look: None,
            });
        AvatarActor {
            activity: a.current.verb.clone(),
            appearance,
            body: w.body_view(&a.id),
            busy: !a.interaction_available() || awaiting,
            id: a.id.clone(),
            inventory: w.inventory_view(&a.id),
            locus: a.locus.clone(),
            name: a.name.clone(),
            // 化身没有身体需求。
            needs: if a.is_avatar() {
                vec![]
            } else {
                a.needs.states()
            },
            present: a.present(),
            remaining: a.current.left_text(),
            revision: a.actions.revision,
        }
    }

    /// 够得着、能看到的人。
    fn nearby_people(&self) -> Vec<NearbyPerson> {
        let a = self.a;
        self.w
            .actors
            .values()
            .filter(|b| b.id != a.id && b.present() && self.reach.pair(&a.id, &b.id).is_ok())
            .map(|b| NearbyPerson {
                activity: b.current.verb.clone(),
                available: b.interaction_available(),
                can_talk: self.w.talk_available(&b.id),
                id: b.id.clone(),
                name: b.name.clone(),
            })
            .collect()
    }

    /// 眼前或随身、而且够得着的道具，带动作说明和容器里的东西。
    fn reachable_props(&self) -> Vec<AvatarPropView> {
        let (w, a) = (self.w, self.a);
        w.topo
            .props()
            .iter()
            .filter(|p| {
                !p.withdrawn
                    && w.inventory.at_hand(&w.props, &a.id, p, &a.locus.locale)
                    && self.reach.prop(&a.id, &p.id).is_ok()
            })
            .map(|p| AvatarPropView {
                actions: p
                    .verbs
                    .iter()
                    .filter_map(|v| v.action.as_ref())
                    .map(|x| crate::props::action_description_for(x, w.physiology()))
                    .collect(),
                bulletin_board: p.bulletin_board,
                carried: w.inventory.carried_by(&p.id, &a.id),
                contents: w.container_items(&a.id, &p.id),
                id: p.id.clone(),
                name: p.name.clone(),
                portable: p.portable,
                storage_slots: p.storage_slots,
            })
            .collect()
    }

    /// 同一空间里伸手够得着的门口。
    fn nearby_portals(&self, map: &WalkMap) -> Vec<PortalView> {
        let Some(here) = self.w.actor_spot(&self.a.id) else {
            return vec![];
        };
        map.portals
            .iter()
            .filter(|p| {
                p.from.space == here.space && distance(p.from.position, here.position) <= REACH
            })
            .map(|p| PortalView {
                id: p.id.clone(),
                label: p.label.clone(),
            })
            .collect()
    }

    /// 附近的聊天：成员都够得着（不隔墙）才列出。
    fn reachable_chats(&self) -> Vec<NearbyChat> {
        let actor = &self.a.id;
        self.w
            .nearby_chats(actor)
            .into_iter()
            .filter(|c| {
                c.members
                    .iter()
                    .all(|id| self.reach.pair(actor, id).is_ok())
            })
            .collect()
    }

    /// 互动的观察，加上邀请内容与玩家此刻能不能发言、能不能请求发言。
    fn interaction(&self, i: &Interaction) -> AvatarInteraction {
        let actor = &self.a.id;
        let can_speak = self.w.chat_turn(actor);
        let can_request_turn = i
            .chat
            .as_ref()
            .is_some_and(|c| c.members.contains(actor) && c.resume_at > self.w.minutes);
        match Interactions::observation(actor, i) {
            InteractionObservation::Chat(c) => AvatarInteraction::Chat(AvatarChatItem {
                can_request_turn,
                can_speak,
                entries: c.entries,
                expires_at: i.expires_at,
                id: c.id,
                initiator: c.initiator,
                kind: c.kind,
                locale: c.locale,
                members: c.members,
                message: i.message.clone(),
                partner: c.partner,
                reason: i.reason.clone(),
                reply: i.reply.clone(),
                status: c.status,
                turn: c.turn,
                response_error: None,
            }),
            InteractionObservation::Pair(p) => AvatarInteraction::Pair(AvatarPairItem {
                accepted: p.accepted,
                can_request_turn,
                can_speak,
                changes: p.changes,
                created_at: p.created_at,
                duration_minutes: p.duration_minutes,
                ended_at: p.ended_at,
                event_ids: p.event_ids,
                expires_at: p.expires_at,
                id: p.id,
                initiator: p.initiator,
                kind: p.kind,
                locale: p.locale,
                message: p.message,
                partner: p.partner,
                reason: p.reason,
                reply: p.reply,
                started_at: p.started_at,
                status: p.status,
                response_error: None,
            }),
        }
    }
}

/// 最近几个动作回执里的变化与失败原因，新的在前。
fn feedback(a: &Actor) -> Vec<String> {
    let mut results: Vec<_> = a.actions.groups.values().flat_map(|g| &g.results).collect();
    results.sort_by(|x, y| {
        y.ended_at
            .total_cmp(&x.ended_at)
            .then_with(|| y.action_id.cmp(&x.action_id))
    });
    results
        .into_iter()
        .take(FEEDBACK_ACTIONS)
        .flat_map(|r| r.changes.iter().cloned().chain(r.reason.iter().cloned()))
        .collect()
}
