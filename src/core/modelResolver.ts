import type { ModelCatalogEntry, PoolKey } from '../types.ts';

/**
 * Builds a Map indexing lowercased rawId, modelId, and label for O(1) lookup.
 */
export function buildModelCatalogIndex(
  entries: ModelCatalogEntry[],
): Map<string, ModelCatalogEntry> {
  const index = new Map<string, ModelCatalogEntry>();
  if (!Array.isArray(entries)) {
    return index;
  }

  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if (entry.rawId && entry.rawId.trim()) {
      index.set(entry.rawId.trim().toLowerCase(), entry);
    }
    if (entry.modelId && entry.modelId.trim()) {
      index.set(entry.modelId.trim().toLowerCase(), entry);
    }
    if (entry.label && entry.label.trim()) {
      index.set(entry.label.trim().toLowerCase(), entry);
    }
  }

  return index;
}

const STATIC_MODEL_MAP: Record<string, string> = {
  // Flash placeholders
  model_placeholder_m318: 'Gemini 3.8 Flash (High)',
  model_placeholder_m319: 'Gemini 3.8 Flash (Medium)',
  model_placeholder_m320: 'Gemini 3.8 Flash (Low)',
  // Opus placeholders
  model_placeholder_m400: 'Claude Opus 5.5 (Low)',
  model_placeholder_m401: 'Claude Opus 5.5 (Medium)',
  model_placeholder_m402: 'Claude Opus 5.5 (High)',
  // Sonnet placeholders
  model_placeholder_m403: 'Claude Sonnet 5.5 (Low)',
  model_placeholder_m404: 'Claude Sonnet 5.5 (Medium)',
  model_placeholder_m405: 'Claude Sonnet 5.5 (High)',
  // Argon placeholders
  model_placeholder_m417: 'Gemini 4 Argon (High)',
  model_placeholder_m418: 'Gemini 4 Argon (Medium)',
  model_placeholder_m419: 'Gemini 4 Argon (Low)',
  // Hydrogen placeholders
  model_placeholder_m525: 'Gemini 4 Hydrogen (High)',
  model_placeholder_m526: 'Gemini 4 Hydrogen (Medium)',
  model_placeholder_m527: 'Gemini 4 Hydrogen (Low)',
  model_placeholder_m528: 'Gemini 4 Hydrogen (XHigh)',
  // OpenAI OSS
  model_openai_gpt_oss_120b_medium: 'GPT-OSS 120B (Medium)',
  // Claude 4 / 4.5
  model_claude_4_sonnet: 'Claude 4 Sonnet',
  model_claude_4_sonnet_thinking: 'Claude 4 Sonnet (Thinking)',
  model_claude_4_opus: 'Claude 4 Opus',
  model_claude_4_opus_thinking: 'Claude 4 Opus (Thinking)',
  model_claude_4_5_sonnet: 'Claude 4.5 Sonnet',
  model_claude_4_5_sonnet_thinking: 'Claude 4.5 Sonnet (Thinking)',
  // SQLite slugs
  'gemini-4-argon-trial': 'Gemini 4 Argon (Trial)',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-pro-default': 'Gemini Pro',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'claude-opus-5-5-low': 'Claude Opus 5.5 (Low)',
};

const SUFFIX_QUALIFIERS: Record<string, string> = {
  high: '(High)',
  medium: '(Medium)',
  low: '(Low)',
  xhigh: '(XHigh)',
  trial: '(Trial)',
  thinking: '(Thinking)',
};

function humanizeModelSlug(slug: string): string {
  // Replace version hyphens like 5-5 -> 5.5, 4-6 -> 4.6
  const normalized = slug.replace(/(\d+)-(\d+)/g, '$1.$2');
  const parts = normalized.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) {
    return slug;
  }

  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lower = part.toLowerCase();

    // Drop trailing default / tiered
    if (i === parts.length - 1 && (lower === 'default' || lower === 'tiered')) {
      continue;
    }

    // Trailing qualifier
    if (i === parts.length - 1 && SUFFIX_QUALIFIERS[lower]) {
      result.push(SUFFIX_QUALIFIERS[lower]);
      continue;
    }

    if (lower === 'gpt') {
      result.push('GPT');
    } else if (lower === 'oss') {
      result.push('OSS');
    } else if (/^\d+b$/i.test(part)) {
      result.push(part.toUpperCase());
    } else if (/^\d+(\.\d+)?$/.test(part)) {
      result.push(part);
    } else {
      result.push(lower.charAt(0).toUpperCase() + lower.slice(1));
    }
  }

  return result.join(' ');
}

/**
 * Resolves a raw model identifier (placeholder ID, protobuf modelName, SQLite slug) into a human-friendly label.
 */
export function resolveModelName(
  rawModel: string | undefined | null,
  catalog?: Map<string, ModelCatalogEntry> | ModelCatalogEntry[],
): string {
  if (!rawModel || !rawModel.trim()) {
    return 'Unknown';
  }

  const trimmed = rawModel.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'unknown' || lower === 'model_unspecified') {
    return 'Unknown';
  }

  // 1. Check live catalog first
  if (catalog instanceof Map) {
    const entry = catalog.get(lower);
    if (entry?.label) {
      return entry.label;
    }
  } else if (Array.isArray(catalog)) {
    const entry = catalog.find(
      (e) =>
        e.rawId?.trim().toLowerCase() === lower ||
        e.modelId?.trim().toLowerCase() === lower ||
        e.label?.trim().toLowerCase() === lower,
    );
    if (entry?.label) {
      return entry.label;
    }
  }

  // 2. Static fallback map
  if (STATIC_MODEL_MAP[lower]) {
    return STATIC_MODEL_MAP[lower];
  }

  // 3. Smart humanizer
  const placeholderMatch = trimmed.match(/^MODEL_PLACEHOLDER_([A-Za-z0-9_]+)$/i);
  if (placeholderMatch) {
    return `Model ${placeholderMatch[1].toUpperCase()}`;
  }

  return humanizeModelSlug(trimmed);
}

/**
 * Infers the quota pool key ('gemini', 'argon', or 'nonGoogle') from a model name or label.
 */
export function inferModelPool(
  rawOrLabel: string,
  catalog?: Map<string, ModelCatalogEntry> | ModelCatalogEntry[],
): PoolKey {
  if (!rawOrLabel || !rawOrLabel.trim()) {
    return 'nonGoogle';
  }

  const key = rawOrLabel.trim().toLowerCase();

  // 1. Check catalog first
  if (catalog instanceof Map) {
    const entry = catalog.get(key);
    if (entry?.poolKey) {
      return entry.poolKey;
    }
  } else if (Array.isArray(catalog)) {
    const entry = catalog.find(
      (e) =>
        e.rawId?.trim().toLowerCase() === key ||
        e.modelId?.trim().toLowerCase() === key ||
        e.label?.trim().toLowerCase() === key,
    );
    if (entry?.poolKey) {
      return entry.poolKey;
    }
  }

  // 2. Fallbacks: argon first, then gemini, else nonGoogle
  if (/argon/i.test(rawOrLabel)) {
    return 'argon';
  }
  if (/gemini/i.test(rawOrLabel)) {
    return 'gemini';
  }
  return 'nonGoogle';
}
