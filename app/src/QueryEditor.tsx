import { useEffect, useRef } from 'react'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { fields } from './query'

export type EditorHandle = {
  replace(text: string): void
  undo(): void
  redo(): void
  focus(): void
}

export function QueryEditor({
  initial,
  onChange,
  onReady,
  onRun,
}: {
  initial: string
  onChange(text: string, undoAvailable: boolean, redoAvailable: boolean): void
  onReady(handle: EditorHandle): void
  onRun(): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onChange, onReady, onRun })
  callbacks.current = { onChange, onReady, onRun }
  const first = useRef(initial)
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: first.current,
        extensions: [
          history({ minDepth: 100, newGroupDelay: 500 }),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                callbacks.current.onRun()
                return true
              },
            },
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'Search query',
            role: 'textbox',
            'aria-multiline': 'true',
            spellcheck: 'false',
          }),
          placeholder('time:[now-15m TO now} AND service:"checkout"'),
          autocompletion({
            override: [
              (context) => {
                const word = context.matchBefore(/[\w_:-]*/)
                if (!word || (!context.explicit && word.from === word.to)) return null
                return {
                  from: word.from,
                  options: [
                    ...Object.keys(fields).map((name) => ({ label: `${name}:`, type: 'property' })),
                    ...['AND', 'OR', 'NOT'].map((label) => ({ label, type: 'keyword' })),
                    { label: 'time:[now-15m TO now}', type: 'keyword', detail: 'Last 15 minutes' },
                  ],
                }
              },
            ],
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(
                update.state.doc.toString(),
                undoDepth(update.state) > 0,
                redoDepth(update.state) > 0
              )
          }),
          EditorView.theme(
            {
              '&': { color: '#d7d8db', backgroundColor: '#1a1b1e', fontSize: '13px' },
              '.cm-content': {
                fontFamily: '"IBM Plex Mono", monospace',
                padding: '8px 10px',
                minHeight: '36px',
              },
              '.cm-cursor': { borderLeftColor: '#63f2bf' },
              '&.cm-focused': { outline: '1px solid #008362' },
              '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
                backgroundColor: '#245143',
              },
              '.cm-tooltip': { backgroundColor: '#25262b', border: '1px solid #373a40' },
            },
            { dark: true }
          ),
        ],
      }),
    })
    callbacks.current.onReady({
      replace(text) {
        const current = view.state.doc.toString()
        if (text === current) return
        let from = 0,
          tail = 0
        while (from < current.length && from < text.length && current[from] === text[from]) from++
        while (
          tail < current.length - from &&
          tail < text.length - from &&
          current[current.length - 1 - tail] === text[text.length - 1 - tail]
        )
          tail++
        view.dispatch({
          changes: {
            from,
            to: current.length - tail,
            insert: text.slice(from, text.length - tail),
          },
          annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.filter')],
        })
      },
      undo: () => {
        undo(view)
      },
      redo: () => {
        redo(view)
      },
      focus: () => view.focus(),
    })
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return
      const target = event.target as HTMLElement | null
      // Route physical shortcuts through the same history in any keyboard layout.
      // Other form fields retain their own undo; CodeMirror uses this shared handler.
      if (
        !view.dom.contains(target) &&
        target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')
      )
        return
      const key =
        event.code === 'KeyZ' ? 'z' : event.code === 'KeyY' ? 'y' : event.key.toLowerCase()
      if (key === 'z' || key === 'y') {
        event.preventDefault()
        if (key === 'y' || event.shiftKey) redo(view)
        else undo(view)
      }
    }
    window.addEventListener('keydown', shortcut, true)
    return () => {
      window.removeEventListener('keydown', shortcut, true)
      view.destroy()
    }
  }, [])
  return <div className="query-editor" ref={host} />
}
