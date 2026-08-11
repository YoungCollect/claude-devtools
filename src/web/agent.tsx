import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import claudeCodeMark from '@lobehub/icons-static-svg/icons/claudecode.svg?raw';
import openaiMark from '@lobehub/icons-static-svg/icons/openai.svg?raw';

/**
 * The agents this UI can be pointed at. First entry is the default.
 *
 * The marks come from `@lobehub/icons-static-svg` (MIT) rather than being
 * redrawn here: brand logos change, and a copy of one in this repo is a copy
 * that silently goes stale.
 */
export const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', mark: claudeCodeMark },
  { id: 'openai', label: 'OpenAI', mark: openaiMark },
] as const;

export type Agent = (typeof AGENTS)[number];
export type AgentId = Agent['id'];

export const DEFAULT_AGENT: Agent = AGENTS[0];

/**
 * A brand logo, inlined so it can take the colour of whatever it sits in.
 *
 * The package ships plain SVG files whose fill is `currentColor` and whose box
 * is `1em`, so a mark inherits its container's colour and is sized by
 * `font-size`. The markup is inlined at build time from a dependency — never
 * from captured traffic, a header, or any other runtime string — which is what
 * makes the `dangerouslySetInnerHTML` here safe. An `<img src=…>` would render
 * the same file but lose `currentColor`, and the logo could no longer follow
 * the theme or the role colour behind it.
 */
export function BrandMark({ svg, size = 15 }: { svg: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{ fontSize: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const STORAGE_KEY = 'agent-devtools:agent';

interface AgentContextValue {
  agent: Agent;
  setAgent: (id: AgentId) => void;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

function readStoredAgent(): Agent {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return AGENTS.find((candidate) => candidate.id === stored) ?? DEFAULT_AGENT;
  } catch {
    // A blocked or unavailable storage must not stop the app from rendering.
    return DEFAULT_AGENT;
  }
}

/**
 * The selected agent, shared by the whole page.
 *
 * It is context rather than state passed down because two distant places show
 * it — the header's picker and every assistant turn in the trace — and a second
 * copy of the choice is a second thing that can disagree with the first. One
 * value, one writer, both readers in step by construction.
 *
 * The choice survives a reload for the same reason the theme does: it describes
 * how you work, not what you are looking at right now.
 */
export function AgentProvider({ children }: { children: ReactNode }) {
  const [agent, setAgentState] = useState<Agent>(readStoredAgent);

  const setAgent = useCallback((id: AgentId) => {
    const next = AGENTS.find((candidate) => candidate.id === id);
    if (!next) return;
    setAgentState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next.id);
    } catch {
      // A blocked storage quota must not break the picker.
    }
  }, []);

  const value = useMemo(() => ({ agent, setAgent }), [agent, setAgent]);
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgent must be used inside <AgentProvider>');
  return value;
}
