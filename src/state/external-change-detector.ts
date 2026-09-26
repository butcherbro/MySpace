// External-change detection for the open board (P1.6).
//
// The app polls `get_board_change_seq(boardId)` every few seconds. Both values
// are read on the backend's writer connection:
//   - `dataVersion` (SQLite `PRAGMA data_version`) moves only when ANOTHER
//     connection commits: the MCP server, a second app instance. The app's
//     own writes never move it.
//   - `changeSeq` is the board's trigger-maintained counter; it moves on every
//     write that touches what the board renders, own writes included.
//
// So the open board is reloaded only when someone else wrote (dataVersion)
// AND the write touched this board (changeSeq). Any external write may have
// trashed or restored something, so the trash list is refreshed whenever
// dataVersion moved. A sample for a different board (board switch) only
// re-primes the baseline.

/** One poll result, tagged with the board it was taken for. */
export interface ChangeSample {
  boardId: string;
  dataVersion: number;
  changeSeq: number;
}

export interface ReloadDecision {
  reloadBoard: boolean;
  refreshTrash: boolean;
}

const NOTHING: ReloadDecision = { reloadBoard: false, refreshTrash: false };

/**
 * Decides what to refresh given the previous and the new sample. The caller
 * always adopts `next` as the new baseline afterwards.
 */
export function shouldReload(prev: ChangeSample | null, next: ChangeSample): ReloadDecision {
  if (prev === null || prev.boardId !== next.boardId) return NOTHING;
  if (prev.dataVersion === next.dataVersion) return NOTHING;
  return {
    reloadBoard: prev.changeSeq !== next.changeSeq,
    refreshTrash: true,
  };
}
