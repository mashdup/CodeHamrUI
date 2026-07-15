# Session Checkpointing Implementation Plan

## Overview
Git stash-based checkpointing: auto-stash before each agent turn, allow revert to any checkpoint.
Stashes are separate from commit history, keeping `git log` clean.

## Implementation Order

### Phase 1: Backend (Main Process)
**File: `apps/desktop/src/main/index.ts`**

1. Add helper functions:
   - `gitCreateCheckpoint(cwd: string, sessionId: string): Promise<string | null>`
     - Check if there are changes (`git status --porcelain`)
     - If yes, create stash with message `checkpoint:<sessionId>:<timestamp>`
     - Return stash ref (`stash@{0}`) or null if no changes
   - `gitListCheckpoints(cwd: string, sessionId: string): Promise<Checkpoint[]>`
     - Run `git stash list --format=%gD|%s|%aI`
     - Filter by `checkpoint:<sessionId>:` pattern
     - Parse and return array of checkpoints
   - `gitRevertToCheckpoint(cwd: string, stashRef: string): Promise<boolean>`
     - Apply the stash (`git stash apply <ref>`)
     - Drop newer stashes (they're invalid after revert)
     - Return success/failure
   - `gitCheckpointDiff(cwd: string, stashRef: string): Promise<string | null>`
     - Run `git stash show -p <ref>`
     - Return unified diff or null

2. Add IPC handlers:
   - `git:createCheckpoint`
   - `git:listCheckpoints`
   - `git:revertToCheckpoint`
   - `git:checkpointDiff`

### Phase 2: Preload Bridge
**File: `apps/desktop/src/preload/index.ts`**

3. Expose checkpoint functions to renderer:
   - `createCheckpoint(cwd, sessionId)`
   - `listCheckpoints(cwd, sessionId)`
   - `revertToCheckpoint(cwd, stashRef)`
   - `checkpointDiff(cwd, stashRef)`

**File: `apps/desktop/src/preload/index.d.ts`**

4. Add TypeScript declarations for the new functions

### Phase 3: Frontend Types & State
**File: `apps/desktop/src/renderer/src/workspace/types.ts`**

5. Add Checkpoint type:
   ```typescript
   export interface Checkpoint {
     ref: string        // stash@{N}
     timestamp: number  // unix ms
     sessionId: string
     filesChanged: number
   }
   ```

**File: `apps/desktop/src/renderer/src/workspace/useCheckpoints.ts`** (NEW)

6. Create hook to manage checkpoint state:
   - `checkpoints: Checkpoint[]`
   - `createCheckpoint()` - called before each turn
   - `listCheckpoints()` - refresh from git
   - `revertToCheckpoint(ref)` - revert and refresh UI
   - `getCheckpointDiff(ref)` - get diff for preview

### Phase 4: Turn Lifecycle Integration
**File: `apps/desktop/src/renderer/src/workspace/useAgentEvents.ts`**

7. Integrate checkpoint creation:
   - Before sending user message to agent, call `createCheckpoint()`
   - Store returned checkpoint in state
   - Handle errors gracefully (non-git repos, no changes)

### Phase 5: UI Components

**File: `apps/desktop/src/renderer/src/components/CheckpointTimeline.tsx`** (NEW)

8. Build timeline component:
   - Vertical list of checkpoints, newest first
   - Each entry shows: timestamp, files changed, "N minutes ago"
   - Click to expand and show diff preview
   - "Revert to this checkpoint" button on each entry
   - Empty state: "No checkpoints yet"

**File: `apps/desktop/src/renderer/src/components/RevertModal.tsx`** (NEW)

9. Build revert confirmation modal:
   - Show diff preview (reuse `diff.ts` rendering)
   - Warning message: "This will revert N files to their state at <timestamp>"
   - "Revert" and "Cancel" buttons
   - On revert: call `revertToCheckpoint()`, refresh file tree + git status
   - Show toast on success

**File: `apps/desktop/src/renderer/src/Workspace.tsx`**

10. Add checkpoint UI integration:
    - Add "History" button to status bar or toolbar
    - Toggle CheckpointTimeline panel (slide-out or modal)
    - Wire up RevertModal
    - Show checkpoint count badge if >0

### Phase 6: Edge Cases & Polish

11. Handle edge cases:
    - Non-git repos: hide checkpoint UI or show "Requires git" message
    - Merge conflicts during revert: show error modal
    - No changes before turn: don't create empty checkpoint
    - Stash limit: warn if >20 checkpoints

12. Testing:
    - Manual test: agent makes changes → checkpoint created → revert works
    - Test with non-git repo: features hidden/disabled
    - Test merge conflict scenario
    - Test with no changes (should skip checkpoint)

## Key Design Decisions

1. **Stash message format**: `checkpoint:<sessionId>:<timestamp>`
   - Allows filtering by session
   - Timestamp enables sorting and display

2. **Checkpoint creation timing**: Before each turn starts
   - Captures state before agent makes changes
   - Allows reverting the entire turn

3. **Revert strategy**: `git stash apply` + drop newer stashes
   - Apply (not pop) so we can control which stashes to drop
   - Drop newer stashes because they're based on a state that no longer exists

4. **UI placement**: Slide-out panel from right (like file preview)
   - Non-intrusive, always accessible
   - Can preview diffs before reverting

5. **Storage**: Git stash (not separate files)
   - Efficient (git deduplicates)
   - Atomic (git handles consistency)
   - No extra disk management

## Estimated Effort
- Phase 1-2: 3-4 hours (backend + preload)
- Phase 3-4: 2-3 hours (types + integration)
- Phase 5: 4-5 hours (UI components)
- Phase 6: 2-3 hours (edge cases + testing)
- **Total: 11-15 hours**
