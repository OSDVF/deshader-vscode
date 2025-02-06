import * as path from 'path-browserify'
import * as vscode from 'vscode'
import { Communicator, ConnectionState, DeshaderScheme, isTagged } from './deshader'

const VFS_GUIDE = "https://github.com/OSDVF/deshader/blob/main/guide/Filesystem.md"

export class File implements vscode.FileStat {

	type: vscode.FileType
	ctime: number
	mtime: number
	size: number

	name: string
	data?: Uint8Array

	constructor(name: string) {
		this.type = vscode.FileType.File
		this.ctime = Date.now()
		this.mtime = Date.now()
		this.size = 0
		this.name = name
	}
}

export class Directory implements vscode.FileStat {

	type: vscode.FileType
	ctime: number
	mtime: number
	size: number

	name: string
	entries: Map<string, File | Directory>

	constructor(name: string) {
		this.type = vscode.FileType.Directory
		this.ctime = Date.now()
		this.mtime = Date.now()
		this.size = 0
		this.name = name
		this.entries = new Map()
	}
}

export type Entry = File | Directory
type ErrorFunction = (e: unknown) => void

/**
 * Deshader virtual filesystem provider (scheme: 'deshader[ws]')
 */
export class DeshaderFilesystem implements vscode.FileSystemProvider {
	root = new Directory('');
	output: vscode.OutputChannel
	comm: Communicator

	private vscodeVirtual: {
		[key: string]: string | undefined
	} = {};

	constructor(output: vscode.OutputChannel, comm: Communicator, connection?: string) {
		this.output = output
		this.comm = comm
		this.vscodeVirtual = {// TODO write to a "defaults" file
			"launch.json": (typeof deshader != 'undefined' && (comm.isConnected || deshader.commands)) ? JSON.stringify({
				configurations: [
					{
						name: "Deshader Integrated",
						type: "deshader",
						request: "attach",
						connection: connection,
						stopOnEntry: true
					}
				]
			}) : undefined,
			"settings.json": JSON.stringify({}),
			"extensions.json": JSON.stringify({
				recommendations: ["osdvf.deshader", "filippofracascia.glsl-language-support"]
			})
		}
	}

	private showingError = false
	private lastCheck: Promise<void> | null = null
	// Still suffers from "time-of-check to time-of-use" errors, but it's at least something
	async checkConnection() {
		switch (this.comm.connectionState) {
			// @ts-expect-error 
			case ConnectionState.Connecting:
				await this.comm.ensureConnected()
			// fallthrough
			case ConnectionState.Connected:
				return
			case ConnectionState.Disconnected:
				if (this.showingError) {
					throw vscode.FileSystemError.Unavailable("Not connected to Deshader")
				}
				this.showingError = true
				const hasEndpoint = this.comm.endpointURL != null
				try {
					const value = await vscode.window.showErrorMessage(`Not connected to Deshader` + (hasEndpoint ? `. Connect to ${this.comm.endpointURL}?` : ''), "Connect")
					if (value) {
						let resolve: VoidFunction | null = null
						let reject: ErrorFunction | null = null
						let waitFor = Promise.resolve()
						if (this.lastCheck) {
							waitFor = this.lastCheck
						}
						this.lastCheck = new Promise<void>((res, rej) => {
							resolve = res
							reject = rej
						})
						await waitFor
						try {
							if (hasEndpoint) {
								await this.comm.ensureConnected()
								if (resolve != null) (resolve as VoidFunction)()
							} else {
								await vscode.commands.executeCommand("deshader.connect")
								await this.comm.ensureConnected()
								if (resolve) (resolve as VoidFunction)()
							}
						} catch (e) {
							if (reject) (reject as ErrorFunction)(e)
						}
					} else {
						throw vscode.FileSystemError.Unavailable("Not connected to Deshader")
					}
					this.showingError = false
					return
				} catch (e) {
					this.showingError = false
					throw e
				}
		}
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		await this.checkConnection()

		const codeRoot = uri.path.indexOf("/.vscode")
		if (codeRoot != -1) {
			const id = uri.path.substring(codeRoot + 9)
			if (!id) {
				return {
					type: vscode.FileType.Directory,
					permissions: vscode.FilePermission.Readonly,
					ctime: Date.now(),
					mtime: Date.now(),
					size: 0
				}
			}
			const target = this.vscodeVirtual[id]
			if (target) {
				return {
					type: vscode.FileType.File,
					permissions: vscode.FilePermission.Readonly,
					ctime: Date.now(),
					mtime: Date.now(),
					size: target.length
				}
			}
		}
		try {
			const result = await this.comm.stat({ path: uri.path })
			this.output.appendLine(`Stat ${uri.path} result: ${JSON.stringify(result)}`)
			return result
		}
		catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, uri)
			} else { throw e }
		}
	}

	static convertList(list: string[]): [string, vscode.FileType][] {
		const result: [string, vscode.FileType][] = []

		for (const f of list) {
			let maybeLink = vscode.FileType.Unknown//0
			const linkParts = f.split('>')
			if (linkParts.length > 1) {
				maybeLink = vscode.FileType.SymbolicLink
			}
			if (linkParts[0].endsWith('/')) {
				result.push([linkParts[0], vscode.FileType.Directory | maybeLink])
			} else {
				result.push([linkParts[0], vscode.FileType.File | maybeLink])
			}
		}
		return result
	}

	static throwDeshaderError(e: string, uri: vscode.Uri): vscode.FileSystemError {
		switch (e) {
			case 'DirectoryNotFound':
			case 'TargetNotFound':
			case 'NotTagged':
				return vscode.FileSystemError.FileNotFound(uri)
			case 'TagExists':
				return vscode.FileSystemError.FileExists(uri)
			case 'DirExists':
				return vscode.FileSystemError.FileIsADirectory(uri)
			case 'Protected':
				return vscode.FileSystemError.NoPermissions(uri)
			case 'ContextMismatch':
				return vscode.FileSystemError.NoPermissions("Shaders cannot be moved across contexts")
			case 'TypeMismatch':
				return vscode.FileSystemError.NoPermissions("Programs and shaders have isolated filesystems")
			case 'InvalidPath':
				return vscode.FileSystemError.FileNotFound(`The path ${uri} is not eligible for this operation`)
			default: return new vscode.FileSystemError(`Error \`${e}\` while manipulating ${uri}`)
		}
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		await this.checkConnection()

		const codeRoot = uri.path.indexOf("/.vscode")
		if (codeRoot != -1) {
			return DeshaderFilesystem.convertList(Object.keys(this.vscodeVirtual))
		}

		let list: string[] = []
		try {
			list = await this.comm.list({ path: uri.path.endsWith("/") ? uri.path : uri.path + "/" })
			if (uri.path === "/") {
				list.push(".vscode/")
			}
		} catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, uri)
			} else { throw e }
		}
		return DeshaderFilesystem.convertList(list)
	}

	// --- manage file contents

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		await this.checkConnection()

		const codeRoot = uri.path.indexOf("/.vscode")
		if (codeRoot != -1) {
			return new TextEncoder().encode(this.vscodeVirtual[uri.path.substring(codeRoot + 9)])
		}
		try {
			return new Uint8Array(await (await this.comm.readFile({ path: uri.path })).arrayBuffer())
		} catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, uri)
			} else { throw e }
		}
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		await this.checkConnection()

		if (options.create) {
			throw vscode.FileSystemError.Unavailable("Shaders need to be created in the host application")
		}

		try {
			await this.comm.save({
				path: uri.path,
				compile: true,
				link: true
			}, content)
			this._fireSoon({ type: vscode.FileChangeType.Changed, uri })
		} catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, uri)
			} else { throw e }
		}
	}

	// --- manage files/folders

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		if (!isTagged(newUri.path)) {
			throw vscode.FileSystemError.NoPermissions("Cannot rename to a non-tagged path. See " + VFS_GUIDE)
		}
		await this.checkConnection()

		try {
			await this.comm.rename({ from: oldUri.path, to: newUri.path })

			this._fireSoon(
				{ type: vscode.FileChangeType.Deleted, uri: oldUri },
				{ type: vscode.FileChangeType.Created, uri: newUri }
			)
		} catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, oldUri)
			} else { throw e }
		}
	}

	async delete(uri: vscode.Uri): Promise<void> {
		if (!isTagged(uri.path)) {
			throw vscode.FileSystemError.NoPermissions("Only tags can be deleted. Not real shaders or programs.")
		}
		await this.checkConnection()
		try {
			await this.comm.untag({
				path: uri.path
			})
		} catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, uri)
			} else { throw e }
		}
		const dirname = uri.with({
			path: path.dirname(uri.path)
		})

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted })
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		if (!isTagged(uri.path)) {
			throw vscode.FileSystemError.NoPermissions("Cannot make directory in a non-tagged path. See " + VFS_GUIDE)
		}
		await this.checkConnection()
		try {
			await this.comm.mkdir({
				path: uri.path
			})
		}
		catch (e) {
			if (typeof e === 'string') {
				throw DeshaderFilesystem.throwDeshaderError(e, uri)
			} else { throw e }
		}

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: uri.with({ path: path.dirname(uri.path) }) }, { type: vscode.FileChangeType.Created, uri })
	}

	// --- manage file events

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: NodeJS.Timeout

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { })
	}

	/**
	 * Debounce event
	 */
	private _fireSoon(...events: vscode.FileChangeEvent[]): void {
		this._bufferedEvents.push(...events)

		if (this._fireSoonHandle) {
			clearTimeout(this._fireSoonHandle)
		}

		this._fireSoonHandle = setTimeout(() => {
			this._emitter.fire(this._bufferedEvents)
			this._bufferedEvents.length = 0
		}, 5)
	}
}