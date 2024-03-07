/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as path from 'path'
import * as vscode from 'vscode'
import { Communicator } from './deshader'

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
type PromiseOr<T> = Promise<T> | T

export class DeshaderFilesystem implements vscode.FileSystemProvider {
	root = new Directory('');
	output: vscode.OutputChannel
	comm: Communicator
	liveWorkspace = JSON.stringify({
		folders: [
			{
				path: 'sources',
			},
			{
				path: 'programs'
			},
			{
				path: 'workspace'
			}
		]
	});

	constructor(output: vscode.OutputChannel, comm: Communicator) {
		output.appendLine(`Mounting filesystem with communicator ${comm.uri.toString()}`)
		this.output = output
		this.comm = comm
	}

	// --- manage file metadata

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		if (uri.path === '/live-app.code-workspace') {
			return {
				type: vscode.FileType.File,
				permissions: vscode.FilePermission.Readonly,
				ctime: Date.now(),
				mtime: Date.now(),
				size: this.liveWorkspace.length
			}
		}
		let result
		switch (uri.path.substring(0, 8)) {
			case '/sources':
				result = await this.comm.statSource(uri.path.slice(8))
				break
			case '/program':
				result = await this.comm.statProgram(uri.path.slice(9))
				break
			case '/workspa':
				result = await this.comm.stat(uri.path.slice(10))
				break
		}

		this.output.appendLine(`Stat ${uri.path} result: ${JSON.stringify(result)}`)
		return result
	}

	static convertList(list: string[]): [string, vscode.FileType][] {
		const result: [string, vscode.FileType][] = []

		for (const f of list) {
			let maybeLink = vscode.FileType.Unknown;//0
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

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		let list
		switch (uri.path.substring(0, 8)) {
			case '/sources':
				list = await this.comm.listSources(uri.path.slice(8))
				break
			case '/program':
				list = await this.comm.listPrograms(uri.path.slice(9))
				break
			case '/workspa':
				list = await this.comm.listWorkspace(uri.path.slice(10))
				break
		}
		this.output.appendLine(`Read dir ${uri.toString()} result: ${JSON.stringify(list)}`)
		return DeshaderFilesystem.convertList(list)
	}

	// --- manage file contents

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		this.output.appendLine(`Reading ${uri.toString()}`)
		if (uri.path === '/live-app.code-workspace') {
			this.output.appendLine('Reading workspace file')
			return new TextEncoder().encode(this.liveWorkspace)
		}
		let data
		switch (uri.path.substring(0, 8)) {
			case '/sources':
				data = await this.comm.readFile(uri.path.slice(8))
				break
			case '/program':
				data = await this.comm.readFile(uri.path.slice(9))
				break
			case '/workspa':
				data = await this.comm.readFile(uri.path.slice(10))
				break
		}
		if (data) {
			return new TextEncoder().encode(data)
		}
		throw vscode.FileSystemError.FileNotFound()
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
		this.output.appendLine(`Writing ${uri.toString()}`)
		const basename = path.posix.basename(uri.path)
		const parent = this._lookupParentDirectory(uri)
		let entry = parent.entries.get(basename)
		if (entry instanceof Directory) {
			throw vscode.FileSystemError.FileIsADirectory(uri)
		}
		if (!entry && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri)
		}
		if (entry && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri)
		}
		if (!entry) {
			entry = new File(basename)
			parent.entries.set(basename, entry)
			this._fireSoon({ type: vscode.FileChangeType.Created, uri })
		}
		entry.mtime = Date.now()
		entry.size = content.byteLength
		entry.data = content

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri })
	}

	// --- manage files/folders

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
		this.output.appendLine(`Renaming ${oldUri.toString()} to ${newUri.toString()}`)
		if (!options.overwrite && this._lookup(newUri, true)) {
			throw vscode.FileSystemError.FileExists(newUri)
		}

		const entry = this._lookup(oldUri, false)
		const oldParent = this._lookupParentDirectory(oldUri)

		const newParent = this._lookupParentDirectory(newUri)
		const newName = path.posix.basename(newUri.path)

		oldParent.entries.delete(entry.name)
		entry.name = newName
		newParent.entries.set(newName, entry)

		this._fireSoon(
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri }
		)
	}

	delete(uri: vscode.Uri): void {
		this.output.appendLine(`Deleting ${uri.toString()}`)
		const dirname = uri.with({ path: path.posix.dirname(uri.path) })
		const basename = path.posix.basename(uri.path)
		const parent = this._lookupAsDirectory(dirname, false)
		if (!parent.entries.has(basename)) {
			throw vscode.FileSystemError.FileNotFound(uri)
		}
		parent.entries.delete(basename)
		parent.mtime = Date.now()
		parent.size -= 1
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted })
	}

	createDirectory(uri: vscode.Uri): void {
		this.output.appendLine(`Creating directory ${uri.toString()}`)
		const basename = path.posix.basename(uri.path)
		const dirname = uri.with({ path: path.posix.dirname(uri.path) })
		const parent = this._lookupAsDirectory(dirname, false)

		const entry = new Directory(basename)
		parent.entries.set(entry.name, entry)
		parent.mtime = Date.now()
		parent.size += 1
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { type: vscode.FileChangeType.Created, uri })
	}

	// --- lookup

	private _lookup(uri: vscode.Uri, silent: false): Entry
	private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined
	private _lookup(uri: vscode.Uri, silent: boolean): Entry | undefined {
		const parts = uri.path.split('/')
		let entry: Entry = this.root
		for (const part of parts) {
			if (!part) {
				continue
			}
			let child: Entry | undefined
			if (entry instanceof Directory) {
				child = entry.entries.get(part)
			}
			if (!child) {
				if (!silent) {
					throw vscode.FileSystemError.FileNotFound(uri)
				} else {
					return undefined
				}
			}
			entry = child
		}
		return entry
	}

	private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
		const entry = this._lookup(uri, silent)
		if (entry instanceof Directory) {
			return entry
		}
		throw vscode.FileSystemError.FileNotADirectory(uri)
	}

	private _lookupAsFile(uri: vscode.Uri, silent: boolean): File {
		const entry = this._lookup(uri, silent)
		if (entry instanceof File) {
			return entry
		}
		throw vscode.FileSystemError.FileIsADirectory(uri)
	}

	private _lookupParentDirectory(uri: vscode.Uri): Directory {
		const dirname = uri.with({ path: path.posix.dirname(uri.path) })
		return this._lookupAsDirectory(dirname, false)
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