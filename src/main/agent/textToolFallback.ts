import { randomUUID } from 'node:crypto'
import type { ToolCall } from '../../shared/domain-types'
import type { ToolRegistry } from './registry'
import { repairJsonArgs } from './util'

/**
 * Secondary path for models that emit tool calls as text rather than native `tool_calls`.
 * Strict on purpose: it only treats a span as a tool call when it is wrapped in <tool_call>…</tool_call>
 * or a ```json fence AND parses to an object whose name is a registered tool. It never scans prose, so
 * it cannot fabricate a call from the model merely *discussing* a tool. Matched spans are stripped from
 * the returned text so the chat doesn't show raw JSON and the next turn isn't confused by a doubled call.
 */
export function extractTextToolCalls(
  text: string,
  registry: ToolRegistry
): { calls: ToolCall[]; cleanedText: string; rawBlocks: Record<string, string> } {
  const definitions = new Map(registry.list().map((definition) => [definition.name, definition]))
  const names = new Set(definitions.keys())
  const calls: ToolCall[] = []
  const rawBlocks: Record<string, string> = {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addOne = (obj: Record<string, any>, rawBlock: string): boolean => {
    const name = (obj.name ?? obj.tool) as string | undefined
    if (!name || !names.has(name)) return false
    const argsObj = obj.arguments ?? obj.parameters ?? obj.args ?? obj.params ?? {}
    // Strip the model's FORMATTING blank-lines from every string value — the SAME poison as the XML path,
    // but here values arrive via the JSON form (escaped "\n…\n"), which bypassed coerceParam. Without this a
    // JSON-form call leaves path="\nC:\…\n" → file-not-found. Preserves first-line indentation (see helper).
    const cleaned =
      argsObj && typeof argsObj === 'object' && !Array.isArray(argsObj)
        ? Object.fromEntries(
            Object.entries(argsObj as Record<string, unknown>).map(([k, val]) => [
              k,
              typeof val === 'string' ? stripBracketingBlankLines(val) : val
            ])
          )
        : argsObj
    const id = `text_${randomUUID().slice(0, 8)}`
    calls.push({
      id,
      name,
      arguments: typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned)
    })
    rawBlocks[id] = rawBlock
    return true
  }

  const tryAdd = (raw: string, rawBlock: string): boolean => {
    const parsed = tryParse(raw)
    if (!parsed) return false
    // A <tool_calls> block may hold an array of calls — accept each registered one.
    if (Array.isArray(parsed)) {
      let any = false
      for (const el of parsed) {
        if (el && typeof el === 'object' && addOne(el as Record<string, unknown>, rawBlock)) any = true
      }
      return any
    }
    return addOne(parsed as Record<string, unknown>, rawBlock)
  }

  // Hermes/Qwen XML tool-call form: <function=NAME><parameter=KEY>VALUE</parameter>…</function>
  // (also <function name="NAME"> / <parameter name="KEY">). Parameter VALUES are RAW text — no JSON
  // escaping — which is exactly why weak local models emit large code args far more reliably this way than
  // as a JSON string. Values are kept verbatim (whitespace preserved) so edit_file old_string matches.
  const tryAddXml = (body: string, rawBlock: string): boolean => {
    const fn = body.match(/<function(?:\s*=\s*|\s+name\s*=\s*["'])\s*([a-zA-Z0-9_]+)\s*["']?\s*>/i)
    if (!fn || !names.has(fn[1])) return false
    const args: Record<string, unknown> = {}
    const paramRe = /<parameter(?:\s*=\s*|\s+name\s*=\s*["']?)\s*([a-zA-Z0-9_]+)\s*["']?\s*>([\s\S]*?)<\/\s*parameter\s*>/gi
    let pm: RegExpExecArray | null
    while ((pm = paramRe.exec(body))) args[pm[1]] = coerceParam(pm[2])
    if (Object.keys(args).length === 0 && definitions.get(fn[1])?.schema.safeParse({}).success === false) {
      const bareChildRe = /<([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)<\/\s*\1\s*>/gi
      let child: RegExpExecArray | null
      while ((child = bareChildRe.exec(body))) args[child[1]] = coerceParam(child[2])
      if (Object.keys(args).length === 0) return false
    }
    const id = `text_${randomUUID().slice(0, 8)}`
    calls.push({ id, name: fn[1], arguments: JSON.stringify(args) })
    rawBlocks[id] = rawBlock
    return true
  }

  // Tolerate the variants weak local models emit: <tool_call> / <tool_calls> (plural), and stray
  // whitespace inside the tags (< tool_call >). Strip a span only when it parsed to a real call.
  const TAG = /<\s*tool_calls?\s*>([\s\S]*?)<\s*\/\s*tool_calls?\s*>/gi
  // Inside a <tool_call> body, accept either the JSON object form or the Hermes/Qwen XML form.
  let cleaned = text.replace(TAG, (m, body) => (tryAdd(body, m) || tryAddXml(body, m) ? '' : m))
  // Some models emit the XML form WITHOUT a <tool_call> wrapper. If nothing matched yet and a <function …>
  // block is present, strip + accept it. Bounded to a single function block to avoid scanning prose.
  if (calls.length === 0) {
    const fnBlock = cleaned.match(/<function[\s\S]*?<\/\s*function\s*>/i)
    if (fnBlock && tryAddXml(fnBlock[0], fnBlock[0])) cleaned = cleaned.replace(fnBlock[0], '')
  }
  // Fenced ```json blocks are far more prone to false positives (a model DOCUMENTING a call in prose).
  // Only fall back to fence-scanning when no explicit tag yielded a call — an unambiguous tagged call is
  // the trustworthy signal; a fenced one is a last resort, not a co-equal source.
  if (calls.length === 0) {
    cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (m, body) => (tryAdd(body, m) ? '' : m))
  }

  return { calls, cleanedText: cleaned.trim(), rawBlocks }
}

// Strip the model's FORMATTING blank-lines that wrap a tool-call value. Models emit each value on its own
// line(s) — `<parameter=path>\n  VALUE  \n</parameter>` or JSON `"path":"\nVALUE\n"` — and keeping those
// newlines poisons scalar args: path "\nC:\…\n" → file-not-found, url "\nhttp://…\n" → mangled, grep
// "\nfoo\n" → no match. This removes leading/trailing BLANK lines (a newline plus that line's horizontal
// whitespace) but is NOT a full trim: the first content line's indentation is real and edit_file's old_string
// must match the file exactly — so `\n      if (x)\n    }\n\n` → `      if (x)\n    }` (6-space indent and the
// internal newline survive). Applied to BOTH the JSON and XML parse paths.
function stripBracketingBlankLines(v: string): string {
  return v.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
}

// Coerce an XML <parameter> value: booleans/numbers (replace_all, line numbers) become real types; string
// values get the bracketing-blank-line strip above.
function coerceParam(v: string): unknown {
  const t = v.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'True') return true
  if (t === 'False') return false
  if (t === 'None') return null
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t)
  return stripBracketingBlankLines(v)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryParse(s: string): Record<string, any> | any[] | null {
  try {
    const v = JSON.parse(s.trim())
    return v && typeof v === 'object' ? v : null
  } catch {
    return repairJsonArgs(s)
  }
}
