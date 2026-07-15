# Feature 1.1: Session Checkpointing & Undo - Work Breakdown

## Overview
Git-based checkpoints that let users revert to previous states after the agent makes changes. Uses `git stash` under the hood to create snapshots before each agent turn.

## Current Status
**Phase 1 (Backend): COMPLETE**
- ✅ Main process functions implemented (`gitCreateCheckpoint`, `gitListCheckpoints`, `gitRevertToCheckpoint`, `gitCheckpointDiff`)
- ✅ IPC handlers wired
- ✅ Preload API exposed
- ✅ TypeScript types defined

**Phase 2-5 (Frontend): IN PROGRESS**
- ✅ CheckpointTimeline component created
- ⏳ Checkpoint diff preview modal
- ⏳ Integration into Workspace
- ⏳ Status bar indicator
- ⏳ Edge case handling

---

## Work Breakdown

### Phase 1: Backend Infrastructure ✅ COMPLETE

**1.1 Main Process Functions** ✅
- Location: `apps/desktop/src/main/index.ts` (lines 1050-1150)
- Functions:
  - `gitCreateCheckpoint(cwd, sessionId)` - Creates a git stash with metadata
  - `gitListCheckpoints(cwd, sessionId)` - Lists all checkpoints for a session
  - `gitRevertToCheckpoint(cwd, stashRef)` - Reverts to a specific checkpoint
  - `gitCheckpointDiff(cwd, stashRef)` - Gets diff for a checkpoint

**1.2 IPC Handlers** ✅
- Location: `apps/desktop/src/main/index.ts` (lines 786-801)
- Channels: `checkpoint:create`, `checkpoint:list`, `checkpoint:revert`, `checkpoint:diff`

**1.3 Preload API** ✅
- Location: `apps/desktop/src/preload/index.ts` (lines 115-125)
- Methods: `checkpointCreate`, `checkpointList`, `checkpointRevert`, `checkpointDiff`

**1.4 TypeScript Types** ✅
- Location: `apps/desktop/src/preload/index.d.ts` (lines 45-55)
- Types: `Checkpoint` interface, method signatures

---

### Phase 2: Agent Lifecycle Integration ⏳ IN PROGRESS

**2.1 Create Checkpoint Before Each Turn**
- Location: `apps/desktop/src/renderer/src/Workspace.tsx`
- Hook into: `sendPrompt()` function (around line 400-450)
- Logic:
  ```typescript
  // Before sending prompt to agent:
  if (connected && !busy) {
    await window.codehamr.checkpointCreate(cwd, sessionId)
  }
  ```
- Need to track `sessionId` (already exists in state)

**2.2 Refresh Checkpoint List After Turn**
- Location: `apps/desktop/src/renderer/src/workspace/useAgentEvents.ts`
- Hook into: `assistant_done` event handler
- Logic: After agent completes a turn, refresh the checkpoint list
- May need to pass checkpoint list state up to Workspace or use a shared hook

**2.3 Handle Checkpoint Creation Failures**
- Gracefully handle non-git repos (return null, don't crash)
- Show toast notification if checkpoint creation fails
- Don't block the agent turn if checkpoint fails

---

### Phase 3: UI Components ⏳ IN PROGRESS

**3.1 CheckpointTimeline Component** ✅
- Location: `apps/desktop/src/renderer/src/components/CheckpointTimeline.tsx`
- Features:
  - Lists all checkpoints with timestamps
  - Shows files changed count
  - Preview and Revert buttons per checkpoint
  - Two-click confirmation for revert

**3.2 Checkpoint Diff Preview Modal** ⏳ TODO
- Location: `apps/desktop/src/renderer/src/components/CheckpointDiffModal.tsx` (create)
- Features:
  - Modal overlay (like Settings modal)
  - Unified diff view using existing `numberDiffLines` helper
  - File list on left, diff on right (or tabs per file)
  - Syntax highlighting (reuse existing diff rendering)
  - "Revert to this checkpoint" button in modal
  - Close button and Esc key handler

**3.3 Integrate Checkpoint UI into Workspace** ⏳ TODO
- Location: `apps/desktop/src/renderer/src/Workspace.tsx`
- Add checkpoint timeline panel:
  - Option A: Sidebar panel (like file tree)
  - Option B: Modal triggered from status bar
  - Option C: Dropdown in the header bar
- Recommendation: **Modal triggered from status bar** (least intrusive, doesn't crowd layout)
- Add state:
  ```typescript
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  const [previewCheckpoint, setPreviewCheckpoint] = useState<string | null>(null)
  ```
- Add handlers:
  ```typescript
  const handleRevert = async (stashRef: string) => {
    const ok = await window.codehamr.checkpointRevert(cwd, stashRef)
    if (ok) {
      showToast('Reverted to checkpoint')
      refreshGitStat()
      reloadDirs([cwd]) // Refresh entire tree
    } else {
      showToast('Revert failed')
    }
  }
  const handlePreview = (stashRef: string) => {
    setPreviewCheckpoint(stashRef)
  }
  ```

---

### Phase 4: Status Bar Integration ⏳ TODO

**4.1 Checkpoint Indicator**
- Location: `apps/desktop/src/renderer/src/components/StatusBar.tsx`
- Add new indicator showing:
  - Checkpoint icon (📍 or similar)
  - Count of checkpoints: "3 checkpoints"
  - Click to open checkpoint timeline modal
- Implementation:
  ```typescript
  // In StatusBar component:
  <button
    onClick={() => setCheckpointsOpen(true)}
    className="flex items-center gap-1 px-2 py-1 rounded hover:bg-zinc-800"
    title="View checkpoints"
  >
    <span>📍</span>
    <span>{checkpointCount} checkpoints</span>
  </button>
  ```
- Need to pass `checkpointCount` as a prop or fetch it in StatusBar

**4.2 Changes Since Last Checkpoint**
- Track number of files changed since last checkpoint
- Show in status bar: "3 changes since last checkpoint"
- Update after each tool call (use `changedPaths` from `useGitStatus`)
- Implementation:
  ```typescript
  // In Workspace.tsx:
  const changesSinceCheckpoint = changedPaths.size
  
  // Pass to StatusBar:
  <StatusBar
    // ... existing props
    changesSinceCheckpoint={changesSinceCheckpoint}
    onOpenCheckpoints={() => setCheckpointsOpen(true)}
  />
  ```

---

### Phase 5: Edge Cases & Error Handling ⏳ TODO

**5.1 Non-Git Repos**
- Detect if workspace is not a git repo
- Hide checkpoint UI entirely (or show "Not available" message)
- Implementation:
  ```typescript
  // In Workspace.tsx:
  const [isGitRepo, setIsGitRepo] = useState(true)
  
  useEffect(() => {
    // Try to create a checkpoint; if it fails, it's not a git repo
    window.codehamr.checkpointCreate(cwd, sessionId).then((ref) => {
      setIsGitRepo(ref !== null)
    })
  }, [cwd])
  
  // Conditionally render checkpoint UI:
  {isGitRepo && <CheckpointTimeline ... />}
  ```

**5.2 Merge Conflicts on Revert**
- If `git stash pop` fails due to conflicts:
  - Show error toast: "Revert failed due to conflicts"
  - Offer to open conflict resolution UI (future feature)
  - For now: just show error, don't crash

**5.3 Checkpoint Cleanup**
- Old checkpoints accumulate over time
- Add cleanup logic:
  - Keep only last 50 checkpoints per session
  - Delete older ones via `git stash drop`
  - Run cleanup after creating new checkpoint

**5.4 Concurrent Checkpoint Creation**
- If user sends multiple prompts rapidly, checkpoints might overlap
- Use a mutex/lock to ensure only one checkpoint is created at a time
- Implementation:
  ```typescript
  const checkpointLock = useRef(false)
  
  const createCheckpoint = async () => {
    if (checkpointLock.current) return
    checkpointLock.current = true
    try {
      await window.codehamr.checkpointCreate(cwd, sessionId)
    } finally {
      checkpointLock.current = false
    }
  }
  ```

---

### Phase 6: Testing & Polish ⏳ TODO

**6.1 Manual Testing**
- Test checkpoint creation after each turn
- Test reverting to various checkpoints
- Test diff preview modal
- Test status bar indicator
- Test non-git repo fallback
- Test rapid prompt sending (concurrent checkpoints)

**6.2 Visual Polish**
- Add animations for checkpoint timeline (fade in/out)
- Add loading states for checkpoint operations
- Add empty state for "No checkpoints yet"
- Ensure dark mode compatibility
- Test responsive layout (narrow windows)

**6.3 Documentation**
- Add tooltip explaining checkpoints
- Add "Learn more" link to docs (future)
- Update README with checkpoint feature

---

## Implementation Order

1. **Phase 2: Agent Lifecycle Integration** (30 min)
   - Hook checkpoint creation into `sendPrompt()`
   - Refresh checkpoint list after turn completes
   - Handle failures gracefully

2. **Phase 3.2: Checkpoint Diff Preview Modal** (1 hour)
   - Create `CheckpointDiffModal.tsx`
   - Reuse existing diff rendering (`numberDiffLines`)
   - Add revert button in modal

3. **Phase 3.3: Integrate Checkpoint UI** (30 min)
   - Add modal trigger to Workspace
   - Wire up revert/preview handlers
   - Add toast notifications

4. **Phase 4: Status Bar Integration** (30 min)
   - Add checkpoint indicator to StatusBar
   - Add "changes since checkpoint" count
   - Wire up click handler

5. **Phase 5: Edge Cases** (1 hour)
   - Non-git repo detection
   - Merge conflict handling
   - Checkpoint cleanup
   - Concurrent checkpoint prevention

6. **Phase 6: Testing & Polish** (1 hour)
   - Manual testing all scenarios
   - Visual polish (animations, loading states)
   - Documentation

**Total estimated time: 4-5 hours**

---

## Files to Create/Modify

### Create:
- `apps/desktop/src/renderer/src/components/CheckpointDiffModal.tsx`

### Modify:
- `apps/desktop/src/renderer/src/Workspace.tsx` (integrate checkpoint UI, hook into agent lifecycle)
- `apps/desktop/src/renderer/src/components/StatusBar.tsx` (add checkpoint indicator)
- `apps/desktop/src/renderer/src/workspace/useAgentEvents.ts` (refresh checkpoints after turn)

---

## Dependencies

- ✅ Git infrastructure (already exists)
- ✅ IPC/Preload API (already implemented)
- ✅ CheckpointTimeline component (already created)
- ⏳ CheckpointDiffModal component (needs creation)
- ⏳ Workspace integration (needs implementation)
- ⏳ StatusBar integration (needs implementation)

---

## Success Criteria

1. ✅ Checkpoints are created automatically before each agent turn
2. ✅ Users can view a timeline of all checkpoints
3. ✅ Users can preview changes in a checkpoint (diff view)
4. ✅ Users can revert to any checkpoint with one click
5. ✅ Status bar shows checkpoint count and changes since last checkpoint
6. ✅ Non-git repos gracefully degrade (no checkpoint UI)
7. ✅ No data loss on revert (merge conflicts handled)
8. ✅ No performance degradation (checkpoint creation < 1s)

---

## Future Enhancements (Out of Scope for 1.1)

- **Undo last change button on tool cards** - Per-tool undo (more granular)
- **Checkpoint naming** - Let users name checkpoints (e.g., "before auth refactor")
- **Checkpoint search** - Search checkpoint diffs for specific changes
- **Checkpoint export** - Export checkpoint as patch file
- **Checkpoint comparison** - Compare two checkpoints side-by-side
- **Automatic checkpoint pruning** - Smart cleanup based on age/importance
