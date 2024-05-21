import * as vscode from 'vscode'
import { Communicator } from './deshader'

let nextTerminalId = 1
// cleanup inconsitent line breaks
const formatText = (text: string) => `\r${text.split(/(\r?\n)/g).join("\r")}\r`
const writeEmitter = new vscode.EventEmitter<string>()
export function deshaderTerminal(comm: Communicator): vscode.ExtensionTerminalOptions {
	const keys = {
		enter: "\r",
		backspace: "\x7f",
		delete: "\x1b[3~",
		right: "\x1b[C",
	}
	const actions = {
		cursorBack: "\x1b[D",
		deleteAll: "\x1b[0K",
		deleteChar: "\x1b[P",
		clear: "\x1b[2J\x1b[3J\x1b[;H",
	}
	function defaultLine() {
		return `dsh${comm.uri.toString()}$ `
	}
	let input = ""
	let cursor = 0
	return {
		name: `Deshader Terminal ${nextTerminalId++}`,
		pty: {
			onDidWrite: writeEmitter.event,
			open() {
				comm.ensureConnected()
				writeEmitter.fire(defaultLine())
			},
			close() { },
			async handleInput(char) {
				switch (char) {
					case keys.enter:
						comm.ensureConnected()

						writeEmitter.fire(`\r${defaultLine()}${input}\r\n`)
						// třrim off leading default prompt
						try {
							// run the command
							const response = await comm.send(input)
							writeEmitter.fire(`\r${formatText(response)}`)
						} catch (error) {
							writeEmitter.fire(`\r${formatText((error as Error).message)}\n`)
						}
						writeEmitter.fire(defaultLine())
						input = ""
						cursor = 0
						break
					case keys.backspace:
						if (input.length <= 0) {
							return
						}
						// remove last character TODO not last
						input = input.slice(0, cursor - 1) + input.slice(cursor)
						cursor--
						writeEmitter.fire(actions.cursorBack)
						writeEmitter.fire(actions.deleteChar)
						return
					case keys.right:
						if (cursor >= input.length) {
							return
						}
						cursor++
						writeEmitter.fire(char)
						return
					case actions.cursorBack:
						if (cursor <= 0) {
							return
						}
						cursor--
						writeEmitter.fire(char)
						return
					case keys.delete:
						input =
							input.slice(0, cursor) +
							input.slice(cursor + 1)
						writeEmitter.fire(actions.deleteChar)
						break
					default:
						// typing a new character
						input += char
						cursor++
						writeEmitter.fire(char)
				}
			},
		},
	}
}