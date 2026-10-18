export interface ClientVisual {
  id: string;
  label: string;
  hex: string;
  bg: string;
  text: string;
  border: string;
  dot: string;
}

const KNOWN_CLIENTS: Record<string, Omit<ClientVisual, "id">> = {
  opencode: {
    label: "OpenCode",
    hex: "#34d399",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-400",
  },
  claude: {
    label: "Claude Code",
    hex: "#fb923c",
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    dot: "bg-orange-400",
  },
  codex: {
    label: "Codex CLI",
    hex: "#22d3ee",
    bg: "bg-cyan-50",
    text: "text-cyan-700",
    border: "border-cyan-200",
    dot: "bg-cyan-400",
  },
  gemini: {
    label: "Gemini CLI",
    hex: "#60a5fa",
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-400",
  },
  "antigravity-cli": {
    label: "Antigravity",
    hex: "#f59e0b",
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-400",
  },
  kilo: {
    label: "Kilo Code",
    hex: "#a3e635",
    bg: "bg-lime-50",
    text: "text-lime-700",
    border: "border-lime-200",
    dot: "bg-lime-400",
  },
  copilot: {
    label: "GitHub Copilot",
    hex: "#38bdf8",
    bg: "bg-sky-50",
    text: "text-sky-700",
    border: "border-sky-200",
    dot: "bg-sky-400",
  },
  commandcode: {
    label: "CommandCode",
    hex: "#fb7185",
    bg: "bg-rose-50",
    text: "text-rose-700",
    border: "border-rose-200",
    dot: "bg-rose-400",
  },
  cursor: {
    label: "Cursor",
    hex: "#facc15",
    bg: "bg-yellow-50",
    text: "text-yellow-700",
    border: "border-yellow-200",
    dot: "bg-yellow-400",
  },
  kimi: {
    label: "Kimi CLI",
    hex: "#2dd4bf",
    bg: "bg-teal-50",
    text: "text-teal-700",
    border: "border-teal-200",
    dot: "bg-teal-400",
  },
  qwen: {
    label: "Qwen Code",
    hex: "#818cf8",
    bg: "bg-indigo-50",
    text: "text-indigo-700",
    border: "border-indigo-200",
    dot: "bg-indigo-400",
  },
};

const FALLBACK_PALETTE: Omit<ClientVisual, "id" | "label">[] = [
  { hex: "#34d399", bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-400" },
  { hex: "#22d3ee", bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-200", dot: "bg-cyan-400" },
  { hex: "#fb923c", bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200", dot: "bg-orange-400" },
  { hex: "#60a5fa", bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", dot: "bg-blue-400" },
  { hex: "#f59e0b", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", dot: "bg-amber-400" },
  { hex: "#fb7185", bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", dot: "bg-rose-400" },
];

export function getClientVisual(client: string): ClientVisual {
  const key = (client || "unknown").toLowerCase();
  const known = KNOWN_CLIENTS[key];
  if (known) {
    return { id: client, ...known };
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const fb = FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
  return {
    id: client,
    label: client,
    ...fb,
  };
}
