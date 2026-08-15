/**
 * Heuristics for the agent loop's "did it actually finish?" decision. Pure + dependency-free so it's
 * unit-testable without pulling in the electron-bound loop module.
 */

/**
 * Did the model stop BEFORE finishing? A no-tool-call reply that (a) was cut off at the token limit,
 * (b) left todos undone, or (c) narrated a next action it never took, is a premature stop — not a real
 * completion. Conservative on the narration heuristic (wrap-ups and questions to the user count as
 * genuinely done) so it nudges when in doubt without misreading a real final answer.
 */
export function isPrematureStop(text: string, finishReason: string, pendingTodos: number): boolean {
  if (finishReason === 'length') return true // truncated output is definitionally unfinished
  if (pendingTodos > 0) return true // its own task list still has open items
  const t = text.trim().toLowerCase()
  if (!t) return false // a pure-empty reply is a different failure (handled by the empty-response notice)
  // Wrapping up, asking the user something, or ending on a question → genuinely done / waiting on them.
  if (
    /\b(let me know|hope (this|that|it) helps|anything else|to sum(marize| up)|in summary|all set|that'?s (it|all|everything)|is there anything|would you like|do you want|shall i|here'?s (a|the) summary|let me (just |quickly )?(check|verify|confirm|make sure|see if|look)|looks (good|correct|right)|that (works|looks|seems)|everything (looks|seems)|all (looks|seems))\b/.test(
      t
    )
  ) {
    return false
  }
  if (/\?\s*$/.test(t)) return false // ends on a question to the user
  // Past-tense REPORT of work already done ("I've added…", "now I've updated the helper") → genuinely done,
  // not a premature stop. Without this, "now i('ve) <verb>ed" trips the first-person-intent heuristic below.
  if (
    /\b(i'?ve|i have|now i'?ve|now i have)\b[^.!?\n]{0,30}\b(added|created|updated|edited|implemented|wrote|written|fixed|changed|made|built|ran|removed|deleted|replaced|applied|refactored|tested|configured|wired|set up|done|finished|completed)\b/.test(
      t
    )
  ) {
    return false
  }
  // First-person intent to act ("I'll add…", "next I need to update…", "let me run…") with no tool call.
  return /\b(i'?ll|i will|now i|next[, ]+i|i need to|i'?m going to|i am going to|i should|let me|let'?s|going to)\b[^.!?\n]{0,90}\b(creat|add|updat|edit|modif|implement|writ|run|fix|chang|mak|build|check|continu|do|set up|wir|refactor|test|appl|remov|delet|replac|install|generat|configur)/.test(
    t
  )
}

/**
 * A "thinking-only" reply: the model produced chain-of-thought — `reasoning_content`, or an inline
 * `<think>`/`<thinking>`/`<reasoning>` block in the content — but no visible answer and no tool call. This
 * is the dominant local thinking-model failure mode (Qwen3/Ollama etc.); the loop recovers it by prefilling
 * the model's own reasoning back and continuing, instead of ending the turn showing raw chain-of-thought.
 * Mirrors Hermes conversation_loop.py:4471-4488. Pure so it can be unit-tested apart from the loop.
 */
export function isThinkingOnly(displayText: string, rawText: string, reasoning: string, toolCallCount: number): boolean {
  if (toolCallCount > 0) return false
  if (displayText.trim()) return false
  return reasoning.trim().length > 0 || /<think|<thinking|<reasoning/i.test(rawText)
}

/**
 * Did the model start a TEXT tool call but get cut off before closing it? An opened `<tool_call>` /
 * `<function=…>` with no matching close (or more `<parameter=>` opens than `</parameter>` closes) means the
 * call was truncated mid-emit — it can't be parsed or executed, so it would otherwise reach the loop as a
 * bogus "no tool call → done". A weak model hits this when it tries to one-shot a huge file. Pure + testable.
 */
export function looksLikeTruncatedToolCall(text: string): boolean {
  if (!text) return false
  const count = (re: RegExp): number => (text.match(re) || []).length
  if (/<\s*tool_call\s*>/i.test(text) && !/<\s*\/\s*tool_call\s*>/i.test(text)) return true
  if (/<function[=\s]/i.test(text) && !/<\/\s*function\s*>/i.test(text)) return true
  if (count(/<parameter[=\s]/gi) > count(/<\/\s*parameter\s*>/gi)) return true
  return false
}

/** Nudge after a cut-off tool call: re-issue it, but SMALLER — don't paste the whole giant file again. */
export function truncatedToolCallNudge(): string {
  return (
    'Your previous message opened a tool call but it was cut off before the closing tags, so nothing ran. ' +
    'Do NOT resend the whole thing — emitting a very large file in one call gets truncated. Instead: write a ' +
    'small SKELETON of the file first with write_file, then add the rest in several smaller edit_file calls. ' +
    'Re-issue the tool call now, smaller.'
  )
}

/** Auto-continue nudge after a premature stop — push the model to ACT rather than narrate, until done. */
export function continuationNudge(pendingTodos: number, finishReason: string): string {
  if (finishReason === 'length') {
    return (
      'Your previous message was cut off at the output limit before you finished. Continue exactly where ' +
      'you left off and complete the remaining work — call the tools to do it.'
    )
  }
  if (pendingTodos > 0) {
    return (
      `You stopped, but ${pendingTodos} item${pendingTodos === 1 ? '' : 's'} on your task list ` +
      `${pendingTodos === 1 ? 'is' : 'are'} still not done. Keep going NOW: call the tools to finish the ` +
      'remaining steps and mark each one completed as you go. Do not just describe what you will do — do it.'
    )
  }
  return (
    'You described a next step but did not take it. Keep going NOW by calling the tools to do it — do not ' +
    'narrate or stop to summarize. Continue until the task is genuinely complete, then give a brief summary.'
  )
}
