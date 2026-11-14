import type { ScopeMode, SessionNode } from '../types.ts';

const UUID_REGEX = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/**
 * Normalizes a file:// URI or filesystem path into a canonical forward-slash path.
 * On Windows, normalizes drive letter paths, removes leading slashes from file URLs,
 * and converts to lowercase for case-insensitive matching.
 */
export function normalizeFsPath(
  uriOrPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let p = uriOrPath.trim();
  if (!p) {
    return '';
  }

  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.slice(7));
    } catch {
      p = p.slice(7);
    }
    // On Windows, file:///C:/... becomes /C:/...; strip the leading slash
    if (platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
      p = p.slice(1);
    }
  }

  // Convert backslashes to forward slashes
  p = p.replace(/\\/g, '/');

  // Collapse consecutive slashes
  p = p.replace(/\/{2,}/g, '/');

  // Strip trailing slash unless it is root '/'
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }

  if (platform === 'win32') {
    p = p.toLowerCase();
  }

  return p;
}

/**
 * Checks whether any session URI matches any workspace path using exact path
 * or descendant path boundary check (/ boundary), handling file:// decoding and
 * Windows casing/drive letters. Rejects sibling paths like /home/u/proj2.
 */
export function isWorkspaceMatch(
  sessionUris: string[],
  workspacePaths: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (sessionUris.length === 0 || workspacePaths.length === 0) {
    return false;
  }

  const normalizedWorkspaces = workspacePaths
    .map((w) => normalizeFsPath(w, platform))
    .filter((w) => w.length > 0);

  if (normalizedWorkspaces.length === 0) {
    return false;
  }

  for (const rawUri of sessionUris) {
    const s = normalizeFsPath(rawUri, platform);
    if (!s) {
      continue;
    }

    for (const w of normalizedWorkspaces) {
      if (s === w || s.startsWith(w + '/') || w.startsWith(s + '/')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts a cascade UUID from Antigravity artifact URIs:
 * - `file:///.../.gemini/antigravity/brain/<uuid>/...`
 * - `jetski-artifact://.../?cascadeId=<uuid>`
 * - `jetski-artifact://artifact/<uuid>/...`
 */
export function extractArtifactCascadeId(uriString: string): string | null {
  if (!uriString || typeof uriString !== 'string') {
    return null;
  }

  // 1. Check for cascadeId= query parameter
  const cascadeMatch = uriString.match(/cascadeId=([0-9a-fA-F-]{36})/i);
  if (cascadeMatch && UUID_REGEX.test(cascadeMatch[1])) {
    return cascadeMatch[1].toLowerCase();
  }

  // 2. Check for brain/<uuid> or .gemini/antigravity/brain/<uuid>
  const brainMatch = uriString.match(
    /(?:[/\\]\.gemini[/\\]antigravity[/\\]brain|[/\\]brain)[/\\]([0-9a-fA-F-]{36})/i,
  );
  if (brainMatch && UUID_REGEX.test(brainMatch[1])) {
    return brainMatch[1].toLowerCase();
  }

  // 3. Check for jetski-artifact:// scheme with UUID
  if (uriString.startsWith('jetski-artifact:')) {
    const m = uriString.match(UUID_REGEX);
    if (m) {
      return m[1].toLowerCase();
    }
  }

  return null;
}

function getRootAncestor(node: SessionNode, byId: Map<string, SessionNode>): SessionNode {
  let curr = node;
  const visited = new Set<string>([curr.id]);
  while (curr.parentId && byId.has(curr.parentId)) {
    if (visited.has(curr.parentId)) {
      break;
    }
    visited.add(curr.parentId);
    curr = byId.get(curr.parentId)!;
  }
  return curr;
}

/**
 * Resolves the active session based on priority order:
 * 1. Pinned session wins (if present in byId, even if idle, subagent, or in another workspace).
 * 2. If pinnedId is provided but missing from byId, flag pinMissing = true and auto-resolve.
 * 3. Auto-resolution within candidate roots (scoped to current workspace or all):
 *    - Running sessions (parent or non-killed child running) > ties broken by lastConversationId,
 *      artifactHintId, then newest lastModifiedTime.
 *    - Idle sessions: lastConversationId > artifactHintId > newest lastModifiedTime.
 */
export function resolveActiveSession(params: {
  roots: SessionNode[];
  byId: Map<string, SessionNode>;
  pinnedId: string | null;
  scope: ScopeMode;
  lastConversationId: string | null;
  artifactHintId: string | null;
}): { active: SessionNode | null; pinMissing: boolean } {
  const { roots, byId, pinnedId, scope, lastConversationId, artifactHintId } = params;

  // 1. Pinned session wins if present in byId
  if (pinnedId && pinnedId.trim() !== '') {
    const pinnedNode = byId.get(pinnedId);
    if (pinnedNode) {
      return { active: pinnedNode, pinMissing: false };
    }
  }

  const pinMissing = Boolean(pinnedId && pinnedId.trim() !== '' && !byId.has(pinnedId));

  // 2. Candidate roots based on scope
  const candidates =
    scope === 'current'
      ? roots.filter((r) => r.matchesWorkspace)
      : [...roots];

  if (candidates.length === 0) {
    return { active: null, pinMissing };
  }

  // 3. Running sessions among candidates (parent or non-killed child running)
  const runningCandidates = candidates.filter(
    (c) => c.rolledUp.isRunning || c.own.isRunning,
  );

  if (runningCandidates.length > 0) {
    if (runningCandidates.length === 1) {
      return { active: runningCandidates[0], pinMissing };
    }

    // Tie-break running candidates
    if (lastConversationId) {
      const match = runningCandidates.find(
        (c) =>
          c.id === lastConversationId ||
          (byId.has(lastConversationId) &&
            getRootAncestor(byId.get(lastConversationId)!, byId).id === c.id),
      );
      if (match) {
        return { active: match, pinMissing };
      }
    }

    if (artifactHintId) {
      const match = runningCandidates.find(
        (c) =>
          c.id === artifactHintId ||
          (byId.has(artifactHintId) &&
            getRootAncestor(byId.get(artifactHintId)!, byId).id === c.id),
      );
      if (match) {
        return { active: match, pinMissing };
      }
    }

    runningCandidates.sort((a, b) => b.lastModifiedTime - a.lastModifiedTime);
    return { active: runningCandidates[0], pinMissing };
  }

  // 4. Idle candidates priority
  if (lastConversationId) {
    const match = candidates.find(
      (c) =>
        c.id === lastConversationId ||
        (byId.has(lastConversationId) &&
          getRootAncestor(byId.get(lastConversationId)!, byId).id === c.id),
    );
    if (match) {
      return { active: match, pinMissing };
    }
  }

  if (artifactHintId) {
    const match = candidates.find(
      (c) =>
        c.id === artifactHintId ||
        (byId.has(artifactHintId) &&
          getRootAncestor(byId.get(artifactHintId)!, byId).id === c.id),
    );
    if (match) {
      return { active: match, pinMissing };
    }
  }

  // Fallback to newest lastModifiedTime
  candidates.sort((a, b) => b.lastModifiedTime - a.lastModifiedTime);
  return { active: candidates[0], pinMissing };
}
