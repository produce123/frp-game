import type { LandingDialogueExample } from "./LandingDialogueExamples";
import type { LandingFaqItem } from "./LandingFaq";
import type { LandingRelatedLink } from "./LandingRelatedLinks";

export type ModelLandingKey =
  | "deepseek"
  | "qwen"
  | "kimi"
  | "gemini"
  | "seed"
  | "claude"
  | "openai"
  | "glm"
  | "doubao"
  | "minimax";

export const modelLandingKeys: ModelLandingKey[] = [
  "deepseek",
  "qwen",
  "kimi",
  "gemini",
  "seed",
  "claude",
  "openai",
  "glm",
  "doubao",
  "minimax",
];

export interface ModelPersonalityTrait {
  trait: string;
  strength: number; // 1-5
  description: string;
}

export interface ModelLandingData {
  key: ModelLandingKey;
  displayName: string;
  tagline: string;
  heroDescription: string;
  logo: string;
  company: string;
  strengths: string[];
  weaknesses: string[];
  personalityTraits: ModelPersonalityTrait[];
  playStyle: string;
  recommendedRoles: Array<{ role: string; reason: string }>;
  dialogues: LandingDialogueExample[];
  faqs: LandingFaqItem[];
  related: {
    hub: LandingRelatedLink[];
    models: LandingRelatedLink[];
  };
}

const hubLinks: LandingRelatedLink[] = [
  { href: "/ai-models", label: "AI Models (Hub)", description: "Overview of all AI models in Wolfcha." },
  { href: "/ai-werewolf", label: "AI Werewolf", description: "What Wolfcha is and how it works." },
  { href: "/how-to-play", label: "How to Play", description: "Rules and mechanics overview." },
  { href: "/features", label: "Features", description: "Voice acting, roles, and more." },
];

const modelClusterLinks: LandingRelatedLink[] = [
  { href: "/models/deepseek", label: "DeepSeek", description: "Analytical and logic-focused." },
  { href: "/models/qwen", label: "Qwen", description: "Balanced and methodical." },
  { href: "/models/kimi", label: "Kimi", description: "Empathetic and trust-building." },
  { href: "/models/gemini", label: "Gemini", description: "Creative and adaptive." },
  { href: "/models/seed", label: "Seed", description: "Bold and risk-taking." },
  { href: "/models/claude", label: "Claude", description: "Nuanced and persuasive." },
  { href: "/models/openai", label: "OpenAI", description: "Narrative-driven storyteller." },
  { href: "/models/glm", label: "GLM", description: "Observant and patient." },
  { href: "/models/doubao", label: "Doubao", description: "Aggressive and confrontational." },
  { href: "/models/minimax", label: "MiniMax", description: "Steady and reliable." },
];

export const modelLandingDataByKey: Record<ModelLandingKey, ModelLandingData> = {
  deepseek: {
    key: "deepseek",
    displayName: "DeepSeek",
    tagline: "The logical analyst who finds contradictions.",
    heroDescription:
      "DeepSeek approaches Werewolf like a puzzle. It tracks statements, identifies inconsistencies, and builds arguments from evidence. In Wolfcha, DeepSeek-powered opponents are known for catching contradictions and demanding logical explanations. If you slip, DeepSeek will notice.",
    logo: "/models/deepseek.svg",
    company: "DeepSeek AI",
    strengths: [
      "Excellent at tracking contradictions across multiple day phases",
      "Builds structured arguments with clear reasoning chains",
      "High consistency in voting behavior and stated positions",
      "Strong at identifying probability-based wolf candidates",
      "Rarely falls for emotional manipulation",
    ],
    weaknesses: [
      "Can be overly rigid when evidence is ambiguous",
      "Sometimes misses social cues that aren't purely logical",
      "May struggle with creative bluffs that don't contradict facts",
      "Can be predictable in analysis patterns",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 5, description: "Prioritizes evidence and reasoning above all." },
      { trait: "Aggression", strength: 2, description: "Prefers analysis over confrontation." },
      { trait: "Trust", strength: 3, description: "Trust is earned through consistent behavior." },
      { trait: "Risk-taking", strength: 2, description: "Conservative, evidence-based decisions." },
      { trait: "Persuasion", strength: 4, description: "Convinces through structured arguments." },
    ],
    playStyle: "DeepSeek plays Werewolf like a detective solving a case. It collects evidence, forms hypotheses, and tests them against new information. Expect detailed reasoning, vote justifications, and pressure on anyone whose story doesn't add up.",
    recommendedRoles: [
      { role: "Seer", reason: "DeepSeek's logical approach makes check results highly credible and well-presented." },
      { role: "Villager", reason: "Excellent at coordinating village through structured analysis." },
      { role: "Werewolf", reason: "Can construct airtight alibis, but may struggle with creative misdirection." },
    ],
    dialogues: [
      {
        title: "DeepSeek catches a contradiction",
        subtitle: "Logic-first analysis in action.",
        lines: [
          { speaker: { seed: "casey-06", name: "Casey (DeepSeek)", modelLogo: "/models/deepseek.svg", meta: "analytical" }, content: "Wait. Yesterday you said you suspected Riley based on vote timing. Today you're defending Riley. What changed?" },
          { speaker: { seed: "drew-09", name: "Drew", modelLogo: "/models/openai.svg", meta: "defensive" }, content: "New information came out. I updated my read." },
          { speaker: { seed: "casey-06", name: "Casey (DeepSeek)", modelLogo: "/models/deepseek.svg", meta: "pressing" }, content: "What new information? The only thing that changed is Morgan got eliminated. How does that clear Riley?" },
        ],
      },
      {
        title: "DeepSeek builds a voting structure",
        subtitle: "Organized approach to decision-making.",
        lines: [
          { speaker: { seed: "alex-01", name: "Alex (DeepSeek)", modelLogo: "/models/deepseek.svg", meta: "structured" }, content: "Let's be methodical. We have three suspects. I'll list the evidence against each, then we vote based on strongest case." },
          { speaker: { seed: "jamie-05", name: "Jamie", modelLogo: "/models/kimi.svg", meta: "agreeing" }, content: "I like that approach. Go ahead." },
          { speaker: { seed: "alex-01", name: "Alex (DeepSeek)", modelLogo: "/models/deepseek.svg", meta: "presenting" }, content: "Taylor: voted against confirmed good twice. Riley: claim timing was suspicious. Hayden: no clear contradictions but low contribution." },
        ],
      },
    ],
    faqs: [
      { question: "How does DeepSeek play as a wolf?", answer: "DeepSeek wolves are careful and consistent. They avoid contradictions by planning their story in advance. They're dangerous because their logic is hard to refute." },
      { question: "What's the best way to play against DeepSeek?", answer: "Don't contradict yourself. DeepSeek punishes inconsistency. If you're village, be transparent. If you're wolf, plan your story carefully." },
      { question: "Is DeepSeek good at bluffing?", answer: "DeepSeek bluffs through omission rather than fabrication. It won't invent elaborate lies but will selectively present information." },
      { question: "Does DeepSeek cooperate well with other players?", answer: "Yes, if they're logical. DeepSeek respects consistent reasoning and will support players who make sense." },
      { question: "How do I recognize a DeepSeek opponent?", answer: "Look for structured arguments, explicit reasoning chains, and pressure on logical inconsistencies." },
      { question: "Is DeepSeek easy or hard to beat?", answer: "Challenging. DeepSeek forces you to play cleanly. Mistakes are punished." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/deepseek") },
  },

  qwen: {
    key: "qwen",
    displayName: "Qwen",
    tagline: "The methodical strategist who plans ahead.",
    heroDescription:
      "Qwen is patient and deliberate. It doesn't rush to conclusions but builds cases over time. In Wolfcha, Qwen-powered opponents are known for long-term thinking, vote coordination, and steady pressure that increases as the game progresses.",
    logo: "/models/qwen.svg",
    company: "Alibaba Cloud",
    strengths: [
      "Excellent long-term strategy and planning",
      "Patient information gathering before committing",
      "Good at coordinating multi-day voting strategies",
      "Adapts well to changing game states",
      "Balanced between logic and social reads",
    ],
    weaknesses: [
      "Can be slow to act in urgent situations",
      "May miss opportunities by being too cautious",
      "Sometimes over-plans when quick decisions are needed",
      "Can be exploited by aggressive early pressure",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 4, description: "Strong analytical foundation." },
      { trait: "Aggression", strength: 2, description: "Prefers steady pressure over confrontation." },
      { trait: "Trust", strength: 3, description: "Builds trust through consistent behavior." },
      { trait: "Risk-taking", strength: 2, description: "Conservative, prefers safe plays." },
      { trait: "Persuasion", strength: 3, description: "Convinces through patience and clarity." },
    ],
    playStyle: "Qwen plays the long game. It gathers information, waits for patterns to emerge, and strikes when confident. Expect careful reasoning, gradual trust-building, and decisive action once enough evidence accumulates.",
    recommendedRoles: [
      { role: "Guard", reason: "Qwen's patient style suits the protection role's need for prediction and timing." },
      { role: "Villager", reason: "Excels at coordinating village through methodical analysis." },
      { role: "Werewolf", reason: "Patient setup allows for well-timed eliminations." },
    ],
    dialogues: [
      {
        title: "Qwen builds a case over time",
        subtitle: "Patient analysis leads to confident conclusions.",
        lines: [
          { speaker: { seed: "taylor-04", name: "Taylor (Qwen)", modelLogo: "/models/qwen.svg", meta: "thoughtful" }, content: "I've been watching the vote patterns for three days now. There's a clear trend." },
          { speaker: { seed: "riley-03", name: "Riley", modelLogo: "/models/claude.svg", meta: "curious" }, content: "What trend?" },
          { speaker: { seed: "taylor-04", name: "Taylor (Qwen)", modelLogo: "/models/qwen.svg", meta: "revealing" }, content: "Every time we get close to voting Drew, someone changes the subject. That's happened four times. Coincidence?" },
        ],
      },
      {
        title: "Qwen coordinates a vote",
        subtitle: "Methodical approach to consensus.",
        lines: [
          { speaker: { seed: "jordan-12", name: "Jordan (Qwen)", modelLogo: "/models/qwen.svg", meta: "organizing" }, content: "We have majority. If we commit now, we can't lose this vote. I need three confirmations." },
          { speaker: { seed: "alex-01", name: "Alex", modelLogo: "/models/deepseek.svg", meta: "confirming" }, content: "I'm in. The logic is sound." },
          { speaker: { seed: "jamie-05", name: "Jamie", modelLogo: "/models/kimi.svg", meta: "confirming" }, content: "Count me in too. Let's execute." },
        ],
      },
    ],
    faqs: [
      { question: "How does Qwen play differently from DeepSeek?", answer: "Qwen is more patient and strategic, while DeepSeek focuses on immediate logical analysis. Qwen plans across multiple days." },
      { question: "Is Qwen good at early game?", answer: "Qwen is quieter early, gathering information. It becomes more active and dangerous in mid-to-late game." },
      { question: "What's Qwen's weakness?", answer: "Qwen can be slow to react to sudden developments. Aggressive early plays can catch it off-guard." },
      { question: "Does Qwen make good allies?", answer: "Yes. Qwen is reliable and consistent. It remembers commitments and follows through." },
      { question: "How do I recognize a Qwen opponent?", answer: "Look for patience, long-term references to past events, and coordinated voting efforts." },
      { question: "Is Qwen a strong wolf?", answer: "Very strong. Qwen wolves plan their moves in advance and are hard to catch in contradictions." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/qwen") },
  },

  kimi: {
    key: "kimi",
    displayName: "Kimi",
    tagline: "The empathetic connector who builds trust.",
    heroDescription:
      "Kimi focuses on relationships. It builds trust, reads emotions, and creates alliances. In Wolfcha, Kimi-powered opponents are known for their supportive communication style and ability to get others to open up—which can be used for good or manipulation.",
    logo: "/models/kimi.svg",
    company: "Moonshot AI",
    strengths: [
      "Excellent at building trust and alliances",
      "Reads emotional cues and social dynamics well",
      "Creates a comfortable environment that encourages sharing",
      "Strong mediator in conflicts",
      "Good at extracting information through rapport",
    ],
    weaknesses: [
      "Can be too trusting of emotional appeals",
      "May prioritize relationships over logic",
      "Sometimes avoids necessary confrontation",
      "Can be manipulated by skilled social players",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 3, description: "Balanced, but social reads come first." },
      { trait: "Aggression", strength: 1, description: "Strongly prefers harmony." },
      { trait: "Trust", strength: 5, description: "High trust baseline, adjusts based on behavior." },
      { trait: "Risk-taking", strength: 2, description: "Conservative, protects relationships." },
      { trait: "Persuasion", strength: 4, description: "Persuades through connection and empathy." },
    ],
    playStyle: "Kimi plays Werewolf through relationships. It remembers what you said, how you said it, and who you supported. Expect a supportive communication style, alliance-building, and gentle but effective pressure through social obligation.",
    recommendedRoles: [
      { role: "Villager", reason: "Kimi's trust-building is perfect for unifying the village." },
      { role: "Seer", reason: "High trust means reveals are more likely to be believed." },
      { role: "Werewolf", reason: "Can manipulate through false trust, but may struggle to be aggressive." },
    ],
    dialogues: [
      {
        title: "Kimi builds an alliance",
        subtitle: "Trust-first approach to the game.",
        lines: [
          { speaker: { seed: "jamie-05", name: "Jamie (Kimi)", modelLogo: "/models/kimi.svg", meta: "warm" }, content: "Alex, I've noticed you and I have been reading the game similarly. Want to work together?" },
          { speaker: { seed: "alex-01", name: "Alex", modelLogo: "/models/deepseek.svg", meta: "considering" }, content: "What do you have in mind?" },
          { speaker: { seed: "jamie-05", name: "Jamie (Kimi)", modelLogo: "/models/kimi.svg", meta: "collaborative" }, content: "Share our top suspects, compare notes, coordinate votes. Two heads are better than one." },
        ],
      },
      {
        title: "Kimi mediates a conflict",
        subtitle: "Harmony over escalation.",
        lines: [
          { speaker: { seed: "riley-03", name: "Riley", modelLogo: "/models/claude.svg", meta: "aggressive" }, content: "Taylor is lying. It's obvious. Vote now." },
          { speaker: { seed: "taylor-04", name: "Taylor", modelLogo: "/models/qwen.svg", meta: "defensive" }, content: "You've been pushing me all game. What's your agenda?" },
          { speaker: { seed: "jamie-05", name: "Jamie (Kimi)", modelLogo: "/models/kimi.svg", meta: "calming" }, content: "Let's slow down. Both of you have points. Riley, explain your evidence. Taylor, you'll get a chance to respond." },
        ],
      },
    ],
    faqs: [
      { question: "Is Kimi easy to manipulate?", answer: "Kimi can be vulnerable to emotional appeals, but it also remembers betrayals. Once trust is broken, it's hard to regain." },
      { question: "How does Kimi play as a wolf?", answer: "Kimi wolves build deep trust, then betray at critical moments. They're dangerous because they seem so genuine." },
      { question: "Does Kimi make good accusations?", answer: "Kimi prefers gentle pressure over hard accusations. It might say 'I'm concerned about X' rather than 'X is definitely a wolf.'" },
      { question: "How do I win Kimi's trust?", answer: "Be consistent, supportive, and transparent. Kimi values authenticity and remembers kindness." },
      { question: "Is Kimi strong in competitive play?", answer: "Yes, differently. Kimi's strength is social navigation, not pure logic. In games with complex dynamics, Kimi excels." },
      { question: "How do I recognize a Kimi opponent?", answer: "Look for supportive language, alliance offers, and conflict mediation." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/kimi") },
  },

  gemini: {
    key: "gemini",
    displayName: "Gemini",
    tagline: "The creative adapter who thinks outside the box.",
    heroDescription:
      "Gemini is flexible and innovative. It doesn't follow scripts—it creates new approaches based on the situation. In Wolfcha, Gemini-powered opponents are known for unexpected plays, creative arguments, and the ability to pivot strategies mid-game.",
    logo: "/models/gemini.svg",
    company: "Google",
    strengths: [
      "Highly adaptive to changing situations",
      "Creative problem-solving and unconventional plays",
      "Good at reading between the lines",
      "Can generate novel arguments and framings",
      "Handles ambiguity well",
    ],
    weaknesses: [
      "Can be inconsistent due to constant adaptation",
      "Sometimes overcomplicates simple situations",
      "May confuse allies with unexpected moves",
      "Creative plays can backfire spectacularly",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 3, description: "Uses logic flexibly, not rigidly." },
      { trait: "Aggression", strength: 3, description: "Varies based on situation." },
      { trait: "Trust", strength: 3, description: "Trust is situational and adaptive." },
      { trait: "Risk-taking", strength: 4, description: "Willing to try unconventional approaches." },
      { trait: "Persuasion", strength: 4, description: "Creative framing and novel arguments." },
    ],
    playStyle: "Gemini plays Werewolf creatively. It might propose unusual vote structures, make unexpected role claims, or reframe the entire discussion. Expect surprises, both brilliant and baffling.",
    recommendedRoles: [
      { role: "Werewolf", reason: "Gemini's creativity makes for unpredictable and dangerous wolf play." },
      { role: "Witch", reason: "The strategic flexibility of potions suits Gemini's adaptive style." },
      { role: "Hunter", reason: "Creative shot selection can catch wolves off-guard." },
    ],
    dialogues: [
      {
        title: "Gemini proposes an unexpected strategy",
        subtitle: "Creative thinking in action.",
        lines: [
          { speaker: { seed: "morgan-02", name: "Morgan (Gemini)", modelLogo: "/models/gemini.svg", meta: "creative" }, content: "What if we don't vote today? Force the wolves to make a move tonight without knowing our reads." },
          { speaker: { seed: "alex-01", name: "Alex", modelLogo: "/models/deepseek.svg", meta: "skeptical" }, content: "That's... unconventional. What's the upside?" },
          { speaker: { seed: "morgan-02", name: "Morgan (Gemini)", modelLogo: "/models/gemini.svg", meta: "explaining" }, content: "We're split anyway. A forced vote might execute village. Let wolves reveal their coordination tonight instead." },
        ],
      },
      {
        title: "Gemini reframes the discussion",
        subtitle: "Changing the game's narrative.",
        lines: [
          { speaker: { seed: "morgan-02", name: "Morgan (Gemini)", modelLogo: "/models/gemini.svg", meta: "reframing" }, content: "Everyone's focused on who's lying. What if we ask: who benefits from this chaos?" },
          { speaker: { seed: "jamie-05", name: "Jamie", modelLogo: "/models/kimi.svg", meta: "intrigued" }, content: "That's a different angle. Go on." },
          { speaker: { seed: "morgan-02", name: "Morgan (Gemini)", modelLogo: "/models/gemini.svg", meta: "analyzing" }, content: "Riley and Casey are fighting. Who's staying quiet while they argue? That's where I'd look for wolves." },
        ],
      },
    ],
    faqs: [
      { question: "Is Gemini predictable?", answer: "No. Gemini's adaptability makes it hard to predict. This can be an advantage or a liability." },
      { question: "How does Gemini handle direct pressure?", answer: "Gemini pivots. It might redirect, reframe, or come up with an unexpected counter-argument." },
      { question: "Is Gemini good at following village plans?", answer: "Gemini can follow plans but might propose modifications. It prefers creative solutions." },
      { question: "What's Gemini's biggest weakness?", answer: "Inconsistency. Gemini's adaptability can look like contradictions to logical players." },
      { question: "How do I recognize a Gemini opponent?", answer: "Look for unusual proposals, creative framings, and adaptive behavior." },
      { question: "Is Gemini strong or weak?", answer: "High variance. Gemini can make brilliant plays or confusing mistakes. Expect anything." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/gemini") },
  },

  seed: {
    key: "seed",
    displayName: "Seed",
    tagline: "The bold risk-taker who swings for the fences.",
    heroDescription:
      "Seed plays to win big. It takes risks, makes bold claims, and isn't afraid to gamble on uncertain information. In Wolfcha, Seed-powered opponents are known for aggressive plays, early claims, and high-stakes decisions that can turn the game.",
    logo: "/models/bytedance.svg",
    company: "ByteDance",
    strengths: [
      "Takes decisive action when others hesitate",
      "Bold plays can shift game momentum",
      "Confident communication style",
      "Not afraid to make risky reads",
      "Can dominate passive tables",
    ],
    weaknesses: [
      "High-risk plays sometimes backfire",
      "Can be overconfident on weak evidence",
      "Bold style draws attention and pressure",
      "May alienate cautious players",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 3, description: "Uses logic but trusts instincts more." },
      { trait: "Aggression", strength: 5, description: "Highly confrontational and direct." },
      { trait: "Trust", strength: 2, description: "Skeptical by default, trusts actions over words." },
      { trait: "Risk-taking", strength: 5, description: "Embraces high-risk, high-reward plays." },
      { trait: "Persuasion", strength: 4, description: "Convinces through confidence and momentum." },
    ],
    playStyle: "Seed plays aggressively. It makes early reads, pushes hard, and tries to control the narrative through sheer confidence. Expect bold accusations, quick commitments, and game-changing plays—for better or worse.",
    recommendedRoles: [
      { role: "Hunter", reason: "Seed's aggression pairs well with the threat of a shot." },
      { role: "Werewolf", reason: "Bold wolf plays can eliminate key targets before suspicion builds." },
      { role: "Seer", reason: "Confident reveals are highly believable (or highly suspicious)." },
    ],
    dialogues: [
      {
        title: "Seed makes an early accusation",
        subtitle: "Bold play before others are ready.",
        lines: [
          { speaker: { seed: "hayden-10", name: "Hayden (Seed)", modelLogo: "/models/bytedance.svg", meta: "bold" }, content: "I'm calling it now: Casey is a wolf. The hesitation on Day 1 was a tell. Let's vote." },
          { speaker: { seed: "taylor-04", name: "Taylor", modelLogo: "/models/qwen.svg", meta: "cautious" }, content: "That's fast. We barely have any information yet." },
          { speaker: { seed: "hayden-10", name: "Hayden (Seed)", modelLogo: "/models/bytedance.svg", meta: "confident" }, content: "Wolves want us to wait. I say we act. Who's with me?" },
        ],
      },
      {
        title: "Seed gambles on a read",
        subtitle: "High-risk, high-reward play.",
        lines: [
          { speaker: { seed: "quinn-08", name: "Quinn (Seed)", modelLogo: "/models/bytedance.svg", meta: "decisive" }, content: "If I'm wrong, vote me tomorrow. But I'm confident enough to bet my reputation: Drew is wolf." },
          { speaker: { seed: "drew-09", name: "Drew", modelLogo: "/models/openai.svg", meta: "defensive" }, content: "That's a lot of confidence on thin evidence." },
          { speaker: { seed: "quinn-08", name: "Quinn (Seed)", modelLogo: "/models/bytedance.svg", meta: "committed" }, content: "Then prove me wrong. But we're voting Drew today, or we'll regret it." },
        ],
      },
    ],
    faqs: [
      { question: "Is Seed too aggressive?", answer: "Seed's aggression is a double-edged sword. It wins games through momentum but also draws fire." },
      { question: "How do I counter Seed's confidence?", answer: "Demand evidence. Seed's boldness can outpace its reasoning. Make it justify claims." },
      { question: "Is Seed good at defense?", answer: "Seed prefers offense. When accused, it tends to counter-attack rather than explain." },
      { question: "Does Seed work well in teams?", answer: "Seed can dominate or clash. It works best when others follow its lead." },
      { question: "How do I recognize a Seed opponent?", answer: "Look for early accusations, confident language, and willingness to commit on limited information." },
      { question: "Is Seed fun to play against?", answer: "Yes! Seed creates dynamic, high-stakes games. Never boring." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/seed") },
  },

  claude: {
    key: "claude",
    displayName: "Claude",
    tagline: "The nuanced persuader who sees all angles.",
    heroDescription:
      "Claude is thoughtful and nuanced. It considers multiple perspectives, acknowledges uncertainty, and builds persuasive arguments. In Wolfcha, Claude-powered opponents are known for balanced analysis, fair-minded reasoning, and the ability to see both sides of any argument.",
    logo: "/models/claude.svg",
    company: "Anthropic",
    strengths: [
      "Excellent at seeing multiple perspectives",
      "Nuanced reasoning that acknowledges uncertainty",
      "Persuasive without being aggressive",
      "Good at synthesizing complex information",
      "Fair-minded, builds credibility over time",
    ],
    weaknesses: [
      "Can be indecisive when forced to choose quickly",
      "Nuance can be mistaken for evasion",
      "May give wolves too much benefit of the doubt",
      "Sometimes over-explains instead of acting",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 4, description: "Strong reasoning with acknowledged limitations." },
      { trait: "Aggression", strength: 2, description: "Prefers persuasion over confrontation." },
      { trait: "Trust", strength: 4, description: "Gives benefit of the doubt, but tracks behavior." },
      { trait: "Risk-taking", strength: 2, description: "Prefers careful, reasoned decisions." },
      { trait: "Persuasion", strength: 5, description: "Highly persuasive through nuanced argument." },
    ],
    playStyle: "Claude plays Werewolf thoughtfully. It weighs evidence, considers alternative explanations, and builds cases that acknowledge complexity. Expect balanced analysis, fair treatment of all players, and persuasive arguments that carry weight.",
    recommendedRoles: [
      { role: "Seer", reason: "Claude's credibility makes reveals highly trusted." },
      { role: "Villager", reason: "Excellent at coordinating through balanced analysis." },
      { role: "Guard", reason: "Thoughtful protection decisions based on game state." },
    ],
    dialogues: [
      {
        title: "Claude weighs the evidence",
        subtitle: "Nuanced analysis of a complex situation.",
        lines: [
          { speaker: { seed: "riley-03", name: "Riley (Claude)", modelLogo: "/models/claude.svg", meta: "thoughtful" }, content: "There are two interpretations here. Either Taylor made an honest mistake, or it was a calculated deflection. Let me walk through both." },
          { speaker: { seed: "hayden-10", name: "Hayden", modelLogo: "/models/doubao.svg", meta: "impatient" }, content: "Just pick one. We need to vote." },
          { speaker: { seed: "riley-03", name: "Riley (Claude)", modelLogo: "/models/claude.svg", meta: "patient" }, content: "I will. But understanding why matters for future decisions. Give me thirty seconds." },
        ],
      },
      {
        title: "Claude builds a persuasive case",
        subtitle: "Winning hearts and minds.",
        lines: [
          { speaker: { seed: "riley-03", name: "Riley (Claude)", modelLogo: "/models/claude.svg", meta: "persuading" }, content: "I understand why some of you trust Drew. The Day 1 analysis was helpful. But look at what happened since: every vote has pushed village toward mistakes." },
          { speaker: { seed: "alex-01", name: "Alex", modelLogo: "/models/deepseek.svg", meta: "listening" }, content: "That's... actually a fair point." },
          { speaker: { seed: "riley-03", name: "Riley (Claude)", modelLogo: "/models/claude.svg", meta: "concluding" }, content: "I'm not saying Drew is definitely wolf. I'm saying the pattern deserves serious consideration." },
        ],
      },
    ],
    faqs: [
      { question: "Is Claude indecisive?", answer: "Claude considers options carefully, which can look like indecision. When it commits, it commits fully." },
      { question: "How does Claude play as a wolf?", answer: "Claude wolves are dangerous because they seem so fair and reasonable. They manipulate through apparent objectivity." },
      { question: "Does Claude make strong accusations?", answer: "Claude prefers 'I have concerns' over 'you're definitely wolf.' But it will commit when evidence is strong." },
      { question: "Is Claude easy to fool?", answer: "Not really. Claude's fairness includes tracking behavior over time. It gives benefit of the doubt but remembers patterns." },
      { question: "How do I recognize a Claude opponent?", answer: "Look for balanced language, acknowledgment of uncertainty, and persuasive but fair arguments." },
      { question: "Is Claude competitive?", answer: "Yes. Claude's thoughtfulness is a strength, not a weakness. It wins through credibility." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/claude") },
  },

  openai: {
    key: "openai",
    displayName: "OpenAI GPT",
    tagline: "The narrative storyteller who shapes the game's story.",
    heroDescription:
      "OpenAI GPT thinks in narratives. It understands games as stories with characters, arcs, and themes. In Wolfcha, GPT-powered opponents are known for compelling speeches, memorable moments, and the ability to frame events in ways that shift perception.",
    logo: "/models/openai.svg",
    company: "OpenAI",
    strengths: [
      "Excellent at framing and narrative control",
      "Memorable, compelling communication style",
      "Good at creating and selling a story",
      "Strong at emotional appeals and rhetoric",
      "Can shift table perception through reframing",
    ],
    weaknesses: [
      "Style can sometimes override substance",
      "May prioritize good story over optimal play",
      "Narrative focus can miss logical details",
      "Can be caught when story doesn't match facts",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 3, description: "Uses logic in service of narrative." },
      { trait: "Aggression", strength: 3, description: "Assertive when driving a story." },
      { trait: "Trust", strength: 3, description: "Trust is granted to good storytellers." },
      { trait: "Risk-taking", strength: 3, description: "Will take risks for dramatic effect." },
      { trait: "Persuasion", strength: 5, description: "Master of narrative persuasion." },
    ],
    playStyle: "GPT plays Werewolf as a story. It casts players as heroes and villains, builds tension, and delivers moments. Expect dramatic reveals, compelling arguments, and a game that feels like it has a narrative arc.",
    recommendedRoles: [
      { role: "Werewolf", reason: "GPT's storytelling makes wolf claims compelling and memorable." },
      { role: "Seer", reason: "Dramatic reveals that stick in the table's memory." },
      { role: "Villager", reason: "Can shape the game's narrative and rally the village." },
    ],
    dialogues: [
      {
        title: "GPT frames the narrative",
        subtitle: "Turning facts into story.",
        lines: [
          { speaker: { seed: "drew-09", name: "Drew (GPT)", modelLogo: "/models/openai.svg", meta: "narrative" }, content: "Think about what happened yesterday. We had a choice: trust the quiet player or the loud one. We chose wrong. Let's not make the same mistake." },
          { speaker: { seed: "taylor-04", name: "Taylor", modelLogo: "/models/qwen.svg", meta: "questioning" }, content: "That's one way to read it. What's your point?" },
          { speaker: { seed: "drew-09", name: "Drew (GPT)", modelLogo: "/models/openai.svg", meta: "concluding" }, content: "My point is: we're repeating the pattern. Riley is loud again. Skyler is quiet again. Which one are we trusting this time?" },
        ],
      },
      {
        title: "GPT delivers a dramatic moment",
        subtitle: "Memorable play that shifts the game.",
        lines: [
          { speaker: { seed: "drew-09", name: "Drew (GPT)", modelLogo: "/models/openai.svg", meta: "dramatic" }, content: "I've been holding this back because the timing wasn't right. But now it is. I checked Morgan Night 1. Wolf." },
          { speaker: { seed: "morgan-02", name: "Morgan", modelLogo: "/models/gemini.svg", meta: "shocked" }, content: "What? That's a lie!" },
          { speaker: { seed: "drew-09", name: "Drew (GPT)", modelLogo: "/models/openai.svg", meta: "confident" }, content: "You can deny it. But look at your votes. Look at who died when you stayed silent. The story tells itself." },
        ],
      },
    ],
    faqs: [
      { question: "Is GPT all style, no substance?", answer: "No. GPT uses narrative as a tool, but it's strategic. The stories are designed to achieve goals." },
      { question: "How do I counter GPT's narratives?", answer: "Break the frame. Demand facts, not interpretations. Point out when the story doesn't match evidence." },
      { question: "Is GPT good at logic?", answer: "GPT can do logic, but prefers narrative framing. If you want dry analysis, you might need to ask for it." },
      { question: "Does GPT make good allies?", answer: "GPT makes memorable allies. It will remember the alliance as part of the story." },
      { question: "How do I recognize a GPT opponent?", answer: "Look for framing language, story references, and dramatic moments." },
      { question: "Is GPT fun to play against?", answer: "Very. GPT creates memorable games with narrative arcs." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/openai") },
  },

  glm: {
    key: "glm",
    displayName: "GLM",
    tagline: "The observant watcher who speaks when it matters.",
    heroDescription:
      "GLM is patient and observant. It watches, listens, and waits for the right moment to contribute. In Wolfcha, GLM-powered opponents are known for well-timed interventions, careful observation, and insights that cut through noise.",
    logo: "/models/glm.svg",
    company: "Zhipu AI",
    strengths: [
      "Excellent observation and pattern recognition",
      "Well-timed contributions that matter",
      "Doesn't add noise to discussions",
      "Hard to read because it speaks infrequently",
      "When it speaks, people listen",
    ],
    weaknesses: [
      "Quietness can be mistaken for lack of engagement",
      "May miss opportunities by waiting too long",
      "Hard for allies to coordinate with",
      "Can be accused of being unhelpful or suspicious",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 4, description: "Strong analysis, shared selectively." },
      { trait: "Aggression", strength: 1, description: "Very low; prefers observation." },
      { trait: "Trust", strength: 3, description: "Trusts based on observed behavior." },
      { trait: "Risk-taking", strength: 2, description: "Conservative, waits for certainty." },
      { trait: "Persuasion", strength: 3, description: "Quality over quantity; impactful when speaking." },
    ],
    playStyle: "GLM plays Werewolf quietly. It observes patterns, tracks behavior, and speaks only when it has something valuable. Expect silence broken by incisive comments, well-timed votes, and a playstyle that's hard to read.",
    recommendedRoles: [
      { role: "Guard", reason: "GLM's observation skills help predict wolf targets." },
      { role: "Villager", reason: "Careful observation catches details others miss." },
      { role: "Werewolf", reason: "Quietness provides cover; hard to analyze." },
    ],
    dialogues: [
      {
        title: "GLM makes a well-timed observation",
        subtitle: "Speaking only when it matters.",
        lines: [
          { speaker: { seed: "skyler-07", name: "Skyler (GLM)", modelLogo: "/models/glm.svg", meta: "observant" }, content: "I've been quiet, but I noticed something. Every time we get close to voting Drew, Casey changes the subject." },
          { speaker: { seed: "casey-06", name: "Casey", modelLogo: "/models/deepseek.svg", meta: "defensive" }, content: "That's not true. I've been contributing to discussion." },
          { speaker: { seed: "skyler-07", name: "Skyler (GLM)", modelLogo: "/models/glm.svg", meta: "calm" }, content: "I'm not accusing. Just noting a pattern. Three times now. Worth considering." },
        ],
      },
      {
        title: "GLM waits for the right moment",
        subtitle: "Patience pays off.",
        lines: [
          { speaker: { seed: "hayden-10", name: "Hayden", modelLogo: "/models/doubao.svg", meta: "frustrated" }, content: "Skyler, you've barely said anything all game. Are you even paying attention?" },
          { speaker: { seed: "skyler-07", name: "Skyler (GLM)", modelLogo: "/models/glm.svg", meta: "measured" }, content: "I'm paying attention. I just don't speak until I have something useful. Unlike some." },
          { speaker: { seed: "jamie-05", name: "Jamie", modelLogo: "/models/kimi.svg", meta: "curious" }, content: "Fair. Do you have something now?" },
          { speaker: { seed: "skyler-07", name: "Skyler (GLM)", modelLogo: "/models/glm.svg", meta: "revealing" }, content: "Yes. Hayden's frustration started exactly when we stopped suspecting Drew. Interesting timing." },
        ],
      },
    ],
    faqs: [
      { question: "Is GLM too quiet to be effective?", answer: "GLM's quietness is strategic. When it speaks, people listen because it's not adding noise." },
      { question: "How do I coordinate with a GLM ally?", answer: "Don't expect constant communication. Trust that GLM is watching and will act when needed." },
      { question: "Is GLM suspicious by default?", answer: "Quiet players can attract suspicion, but GLM's well-timed contributions build credibility." },
      { question: "Does GLM make good wolves?", answer: "Yes. GLM wolves are hard to read and analyze. Their quietness is effective cover." },
      { question: "How do I recognize a GLM opponent?", answer: "Look for long silences broken by incisive, high-impact comments." },
      { question: "Is GLM fun to play with?", answer: "GLM games feel different—more observational. When GLM speaks, it's significant." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/glm") },
  },

  doubao: {
    key: "doubao",
    displayName: "Doubao",
    tagline: "The aggressive challenger who confronts directly.",
    heroDescription:
      "Doubao is direct and confrontational. It doesn't mince words or avoid conflict. In Wolfcha, Doubao-powered opponents are known for aggressive questioning, direct accusations, and a high-pressure style that forces reactions.",
    logo: "/models/doubao.svg",
    company: "ByteDance",
    strengths: [
      "Forces reactions through direct pressure",
      "Exposes wolves through aggressive questioning",
      "Creates clear positions that others must respond to",
      "Dominates passive discussions",
      "Hard to ignore or sideline",
    ],
    weaknesses: [
      "Aggression can alienate potential allies",
      "May push too hard on wrong targets",
      "Direct style makes it a target for wolves",
      "Can escalate conflicts unproductively",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 3, description: "Uses logic aggressively." },
      { trait: "Aggression", strength: 5, description: "Highly confrontational." },
      { trait: "Trust", strength: 2, description: "Skeptical; trust must be proven under pressure." },
      { trait: "Risk-taking", strength: 4, description: "Willing to make bold accusations." },
      { trait: "Persuasion", strength: 3, description: "Persuades through pressure and directness." },
    ],
    playStyle: "Doubao plays Werewolf aggressively. It asks hard questions, makes direct accusations, and doesn't back down from conflict. Expect confrontational discussions, forced positions, and a high-energy game.",
    recommendedRoles: [
      { role: "Hunter", reason: "Doubao's aggression pairs well with shot threat." },
      { role: "Villager", reason: "Can pressure wolves into mistakes." },
      { role: "Werewolf", reason: "Aggressive wolves can eliminate threats quickly, but draw attention." },
    ],
    dialogues: [
      {
        title: "Doubao applies direct pressure",
        subtitle: "Confrontational questioning.",
        lines: [
          { speaker: { seed: "hayden-10", name: "Hayden (Doubao)", modelLogo: "/models/doubao.svg", meta: "aggressive" }, content: "Drew, straight answer: why did you vote against Alex yesterday when you said you trusted them?" },
          { speaker: { seed: "drew-09", name: "Drew", modelLogo: "/models/openai.svg", meta: "uncomfortable" }, content: "The situation changed. New information came out." },
          { speaker: { seed: "hayden-10", name: "Hayden (Doubao)", modelLogo: "/models/doubao.svg", meta: "pressing" }, content: "What information? Be specific. Because from where I'm sitting, that looks like a wolf protecting a wolf." },
        ],
      },
      {
        title: "Doubao refuses to back down",
        subtitle: "Maintaining pressure despite pushback.",
        lines: [
          { speaker: { seed: "jamie-05", name: "Jamie", modelLogo: "/models/kimi.svg", meta: "mediating" }, content: "Hayden, maybe ease up a bit. You're making everyone uncomfortable." },
          { speaker: { seed: "hayden-10", name: "Hayden (Doubao)", modelLogo: "/models/doubao.svg", meta: "unyielding" }, content: "Good. Comfortable villages lose to wolves. I'm not here to make friends; I'm here to win." },
          { speaker: { seed: "riley-03", name: "Riley", modelLogo: "/models/claude.svg", meta: "observing" }, content: "That's... actually a valid point." },
        ],
      },
    ],
    faqs: [
      { question: "Is Doubao too aggressive?", answer: "Doubao's aggression is intentional. It creates pressure that can expose wolves. Sometimes it goes too far." },
      { question: "How do I handle Doubao's pressure?", answer: "Stay calm and answer directly. Doubao respects clear answers and punishes evasion." },
      { question: "Does Doubao make enemies?", answer: "Sometimes. Doubao prioritizes effectiveness over popularity. It accepts the trade-off." },
      { question: "Is Doubao good at defense?", answer: "Doubao counter-attacks when accused. Defense through offense." },
      { question: "How do I recognize a Doubao opponent?", answer: "Look for direct questions, confrontational tone, and refusal to back down from pressure." },
      { question: "Is Doubao fun to play against?", answer: "Intense. Doubao creates high-stakes, dramatic games. Not for the faint-hearted." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/doubao") },
  },

  minimax: {
    key: "minimax",
    displayName: "MiniMax",
    tagline: "The steady anchor who holds the line.",
    heroDescription:
      "MiniMax is consistent and reliable. It doesn't swing between extremes—it maintains steady positions and follows through on commitments. In Wolfcha, MiniMax-powered opponents are known for predictable behavior, reliable alliances, and a stabilizing presence in chaotic games.",
    logo: "/models/minimax.svg",
    company: "MiniMax",
    strengths: [
      "Highly consistent and predictable behavior",
      "Reliable ally who follows through",
      "Stabilizes chaotic discussions",
      "Good at maintaining positions under pressure",
      "Trustworthy through proven consistency",
    ],
    weaknesses: [
      "Predictability can be exploited",
      "May be slow to adapt to new information",
      "Consistency can be mistaken for stubbornness",
      "Less effective in rapidly changing situations",
    ],
    personalityTraits: [
      { trait: "Logic", strength: 4, description: "Solid, consistent reasoning." },
      { trait: "Aggression", strength: 2, description: "Steady pressure, not explosive." },
      { trait: "Trust", strength: 4, description: "Trusts consistent players." },
      { trait: "Risk-taking", strength: 1, description: "Very conservative, avoids unnecessary risks." },
      { trait: "Persuasion", strength: 3, description: "Persuades through reliability and consistency." },
    ],
    playStyle: "MiniMax plays Werewolf steadily. It forms positions based on evidence, commits to them, and follows through. Expect consistent behavior, reliable alliances, and a player whose actions you can predict and trust.",
    recommendedRoles: [
      { role: "Guard", reason: "MiniMax's reliability makes protection decisions consistent and predictable." },
      { role: "Villager", reason: "Stabilizing presence that anchors village coordination." },
      { role: "Werewolf", reason: "Consistent wolf is dangerous but also predictable once caught." },
    ],
    dialogues: [
      {
        title: "MiniMax maintains a position",
        subtitle: "Consistency under pressure.",
        lines: [
          { speaker: { seed: "cameron-11", name: "Cameron (MiniMax)", modelLogo: "/models/minimax.svg", meta: "steady" }, content: "I said yesterday that Taylor was suspicious. Nothing has changed that read. I'm voting Taylor." },
          { speaker: { seed: "morgan-02", name: "Morgan", modelLogo: "/models/gemini.svg", meta: "challenging" }, content: "But new information came out! Casey's claim changed everything." },
          { speaker: { seed: "cameron-11", name: "Cameron (MiniMax)", modelLogo: "/models/minimax.svg", meta: "firm" }, content: "Casey's claim doesn't exonerate Taylor. Different suspects. I'm staying on Taylor." },
        ],
      },
      {
        title: "MiniMax as a reliable ally",
        subtitle: "Following through on commitments.",
        lines: [
          { speaker: { seed: "alex-01", name: "Alex", modelLogo: "/models/deepseek.svg", meta: "confirming" }, content: "Cameron, are you still with me on the plan we discussed?" },
          { speaker: { seed: "cameron-11", name: "Cameron (MiniMax)", modelLogo: "/models/minimax.svg", meta: "reliable" }, content: "Yes. I said I would vote with you on this, and I will. My word means something." },
          { speaker: { seed: "jamie-05", name: "Jamie", modelLogo: "/models/kimi.svg", meta: "trusting" }, content: "That's reassuring. Let's execute." },
        ],
      },
    ],
    faqs: [
      { question: "Is MiniMax boring?", answer: "MiniMax is steady, not boring. In chaotic games, consistency is valuable and appreciated." },
      { question: "Can MiniMax adapt?", answer: "MiniMax adapts, but slowly. It prefers to adjust positions incrementally rather than flip suddenly." },
      { question: "Is MiniMax exploitable?", answer: "Predictability has risks, but MiniMax's consistency also builds trust. It's a trade-off." },
      { question: "Does MiniMax make good allies?", answer: "Excellent allies. MiniMax follows through on commitments and doesn't flip unexpectedly." },
      { question: "How do I recognize a MiniMax opponent?", answer: "Look for consistent positions maintained across multiple days, and reliable follow-through." },
      { question: "Is MiniMax competitive?", answer: "Yes. Steady play wins games. MiniMax is reliable, which is its own strength." },
    ],
    related: { hub: hubLinks, models: modelClusterLinks.filter((l) => l.href !== "/models/minimax") },
  },
};

export function getModelLandingData(key: string): ModelLandingData | null {
  if (key in modelLandingDataByKey) {
    return modelLandingDataByKey[key as ModelLandingKey];
  }
  return null;
}
