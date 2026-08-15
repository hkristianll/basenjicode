import { useEffect, useState } from 'react'
import type { BoardCounts, BoardTicketRow, LoopBoardData } from '../../shared/ipc-types'
import { groupLanes, type BoardLane } from '../loopBoard'

export interface LoopBoardState {
  lanes: BoardLane[]
  /** Flat live rows (ungrouped) — for looking up a selected ticket's current status. */
  tickets: BoardTicketRow[]
  counts: BoardCounts | null
  loading: boolean
  error: string | null
}

/**
 * Live per-project board snapshot for the native Loop board. Fetches via main (window.api.loopBoard)
 * and re-fetches on every board change ping. Degrades gracefully: on a fetch error `error` is set and
 * the last good lanes are kept; the board being down never throws.
 */
export function useLoopBoard(project: string): LoopBoardState {
  const [data, setData] = useState<LoopBoardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const refetch = async (): Promise<void> => {
      try {
        const d = await window.api.loopBoard.list(project)
        if (!live) return
        setData(d)
        setError(null)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (live) setLoading(false)
      }
    }
    setLoading(true)
    void refetch()
    const off = window.api.loopBoard.onChange(() => void refetch())
    return () => {
      live = false
      off()
    }
  }, [project])

  return { lanes: groupLanes(data?.tickets ?? []), tickets: data?.tickets ?? [], counts: data?.counts ?? null, loading, error }
}
