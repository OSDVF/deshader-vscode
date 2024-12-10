/** 
 * @todo inject deshader into any debugging session
 * @todo support shader analysis without a running process
*/
import { MapLike } from 'typescript'
import * as vscode from 'vscode'
import { EventEmitter } from 'events'
import { DebugProtocol } from '@vscode/debugprotocol'

export const Events = {
    connected: Symbol(),
    message: Symbol(),
    error: Symbol(),
    close: Symbol(),
    invalidated: Symbol(),
    stop: Symbol(),
    stopOnBreakpoint: Symbol(),
    stopOnDataBreakpoint: Symbol(),
    stopOnFunction: Symbol(),
    breakpoint: Symbol(),
    output: Symbol(),
    end: Symbol()
}
export type EventArgs = {
    connected: undefined,
    message: String,
    error: Event,
    close: CloseEvent,
    invalidated: DebugProtocol.InvalidatedEvent['body']
    stop: {
        step: number,
        shader: number,
    },
    stopOnBreakpoint: {
        ids: number[],//breakpoint ids list,
        shader: number,
    },
    stopOnDataBreakpoint: number,
    stopOnFunction: String,
    breakpoint: BreakpointEvent,
    // type, text, source, line, column
    output: ["prio" | "out" | "err", DebugProtocol.OutputEvent['body']['group'], string, number, number]
    end: undefined
}
export type RunningShader = {
    id: number,
    name: string,
    groupCount?: number[],
    groupDim: number[],
    selectedGroup?: number[],//same dimensions as groups
    selectedThread: number[],//same dimensions as threads
    type: string,
}
export type State = {
    debugging: boolean,
    breakpoints: Breakpoint[],
    runningShaders: RunningShader[],
    paused: boolean,
    singlePauseMode: boolean,
    lsp?: string,//URL
}
export type AttachArguments = {
    connection?: string
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean
    showDebugOutput?: boolean
}

export type LaunchArguments = AttachArguments & {
    /** An absolute path to the "program" to debug. */
    program: string
    args?: string[]
    cwd?: string
    env?: MapLike<string>,
    console?: 'debugConsole' | 'integratedTerminal' | 'externalTerminal'
    consoleHost?: string
}
type SourceToPath<T> = Omit<T, "source"> & { path: string }
export type Breakpoint = SourceToPath<DebugProtocol.Breakpoint>
export type BreakpointLocation = SourceToPath<DebugProtocol.BreakpointLocationsArguments>
export type BreakpointRequest = SourceToPath<DebugProtocol.SetBreakpointsArguments> & Seq
export type BreakpointEvent = {
    reason: 'changed' | 'new' | 'removed' | string
    breakpoint: Breakpoint
}
export type StackFrame = SourceToPath<DebugProtocol.StackFrame>
export type StackTraceResponse = {
    stackFrames: StackFrame[],
    totalFrames: number
}
export type WithLength<T> = T & { length?: number }
export type Seq = { seq?: number }
export type PathRequest = { path: string } & Seq
export type ListRequest = { path?: string, recursive?: boolean, untagged?: boolean } & Seq
type MessageCallback = (event: MessageEvent) => void

/**
 * Communicates through WS or HTTP with a running Deshader instance
 * Proxies both the virtual file system and the debugger
 */
export class Communicator extends EventEmitter implements vscode.Disposable {
    output: vscode.OutputChannel
    private endpoint: URL | null = null
    private impl: CommunicatorImpl | null = null
    private _onConnected = new Set<VoidFunction>()
    private _onDisconnected = new Set<VoidFunction>()
    private _onMessage = new Set<MessageCallback>()

    constructor(output: vscode.OutputChannel, defaultURL?: string | URL | vscode.Uri, open = true) {
        super()
        if (defaultURL)
            this.endpointURL = defaultURL
        this.output = output
        if (open && defaultURL) {
            this.open()
        }
    }

    get endpointURL(): URL | null {
        return this.endpoint
    }

    set endpointURL(value: string | URL | vscode.Uri) {
        if (value instanceof vscode.Uri) {
            value = value.toString()
        }
        if (typeof value === 'string') {
            const parsed = URL.parse(value)
            if (parsed) {
                this.endpoint = parsed
            } else {
                throw URIError("Could not parse")
            }
        } else {
            this.endpoint = value
        }

        this.updateImpl()
    }

    get onConnected() {
        if(this.impl)
            return this.impl.onConnected
        return this._onConnected
    }
    get onDisconnected() {
        if(this.impl)
            return this.impl.onDisconnected
        return this._onDisconnected
    }
    get onMessage() {
        if(this.impl)
            return this.impl.onMessage
        return this._onMessage
    }

    shown = 0
    private updateImpl() {
        if (this.impl) {
            this.impl.dispose()
            this._onMessage = this.impl.onMessage
            this._onConnected = this.impl.onConnected
            this._onDisconnected = this.impl.onDisconnected
        }
        if (this.endpoint) {
            switch (this.endpoint.protocol) {
                case 'ws:':
                case 'wss:':
                    this.impl = new WSCommunicator(this, false)
                    break
                default:
                    throw new Error(`Unimplemented scheme ${this.endpoint!.protocol}`)
            }
            this.impl.onConnected = this._onConnected
            this.impl.onDisconnected = this._onDisconnected
            this.impl.onMessage = this._onMessage
            this.impl.open()
        } else {
            if (this.shown++ < 3) {
                vscode.window.showErrorMessage("Connect to a Deshader command server first", "Connect").then((item) => {
                    if (item) {
                        vscode.commands.executeCommand("deshader.connect")
                    }
                })
            }
            throw new Error("No endpoint set")
        }
    }

    on<T extends keyof typeof Events>(eventName: (typeof Events)[T], listener: (arg: string | Event) => void): this {
        return super.on(eventName, listener as any)
    }
    onJson<T extends keyof typeof Events>(eventName: (typeof Events)[T], listener: (arg: EventArgs[T]) => void): this {
        return super.on(eventName, (data) => listener(JSON.parse(data)))
    }
    once<T extends keyof typeof Events>(eventName: (typeof Events)[T], listener: (arg: string | Event) => void): this {
        return super.once(eventName, listener as any)
    }
    onceJson<T extends keyof typeof Events>(eventName: (typeof Events)[T], listener: (arg: EventArgs[T]) => void): this {
        return super.once(eventName, (data) => listener(JSON.parse(data)))
    }
    emit<T extends keyof typeof Events>(eventName: (typeof Events)[T], arg?: string | Event): boolean {
        return super.emit(eventName, arg)
    }

    /**
     * Get host name without port
     */
    getHost(): string | undefined {
        return this.endpoint?.hostname
    }

    disconnect(): void {
        this.impl?.disconnect()
    }
    open(): void {
        if (!this.impl) {
            this.updateImpl()
        }
        this.impl!.open()
    }

    get isConnected(): boolean {
        return this.impl?.isConnected || false
    }

    send(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string> {
        if (!this.impl) {
            this.updateImpl()
        }
        return this.impl!.sendCommand(command, body)
    }
    sendParametric(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string> {
        if (!this.impl) {
            this.updateImpl()
        }
        return this.impl!.sendParametric(command, params, body)
    }
    sendParametricJson<T>(command: string, params: MapLike<string | number | boolean | null | undefined> | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<T> {
        if (!this.impl) {
            this.updateImpl()
        }
        return this.impl!.sendParametricJson(command, params, body)
    }

    ensureConnected(): Promise<void> {
        if (!this.impl) {
            this.updateImpl()
        }
        return this.impl!.ensureConnected()
    }

    dispose() {
        this.disconnect()
    }

    stat(req: PathRequest): Promise<vscode.FileStat> {
        return this.sendParametricJson<vscode.FileStat>("stat", req)
    }

    getVersion(): Promise<string> {
        return this.send('version')
    }
    async list(req: ListRequest): Promise<string[]> {
        const sources = await this.sendParametric('list', req)
        return sources.splitNoOrphans('\n')
    }
    async readFile(req: PathRequest): Promise<string> {
        return await this.sendParametric('readFile', req)
    }
    /**
     * Translates a path from the real to virtual file system
     * @param req An absolute filesystem path
     * @returns The path in the virtual file system
     */
    translatePath(req: PathRequest): Promise<string> {
        return this.sendParametric('translatePath', req)
    }

    //
    // Debugging functions
    //
    /// Communication with the debug adapter is not done through the standard JSON protocol, but instead it is
    /// done in the same format as other Deshader WebSocket messages (query strings).
    /// This simplifies the unified communication implementation on the Deshader library side.

    async debug(args: AttachArguments & Seq): Promise<Breakpoint[]> {
        return this.sendParametricJson<Breakpoint[]>('debug', args)
    }

    async terminate(req: DebugProtocol.TerminateArguments & Seq): Promise<void> {
        await this.sendParametric('terminate', req)
    }

    // get current debugger state (because the session could be started from other client than this vscode instance)
    async state(req: Seq): Promise<State> {
        return this.sendParametricJson<State>('state', req)
    }

    setFunctionBreakpoint(breakpoint: DebugProtocol.FunctionBreakpoint & Seq): Promise<Breakpoint> {
        return this.sendParametricJson<Breakpoint>('setFunctionBreakpoint', breakpoint)
    }
    setBreakpoints(req: BreakpointRequest): Promise<Breakpoint[]> {
        return this.sendParametricJson<Breakpoint[]>('setBreakpoints', req)
    }
    async clearBreakpoints(req: PathRequest): Promise<void> {
        await this.sendParametric('clearBreakpoints', req)
    }
    async pauseMode(args: { single: boolean } & Seq): Promise<void> {
        await this.sendParametric('pauseMode', args)
    }
    possibleBreakpoints(args: BreakpointLocation & Seq): Promise<BreakpointLocation[]> {
        return this.sendParametricJson<BreakpointLocation[]>('possibleBreakpoints', args)
    }
    async selectThread(args: { shader: number, thread: number[], group?: number[] } & Seq): Promise<void> {
        await this.sendParametric('selectThread', args)
    }
    stackTrace(args: DebugProtocol.StackTraceArguments & Seq): Promise<StackTraceResponse> {
        return this.sendParametricJson<StackTraceResponse>('stackTrace', args)
    }
    writeMemory(request: DebugProtocol.WriteMemoryArguments & Seq): Promise<DebugProtocol.WriteMemoryResponse['body']> {
        return this.sendParametricJson<DebugProtocol.WriteMemoryResponse['body']>('writeMemory', request)
    }
    readMemory(request: DebugProtocol.ReadMemoryArguments & Seq): Promise<DebugProtocol.ReadMemoryResponse['body']> {
        return this.sendParametricJson<DebugProtocol.ReadMemoryResponse['body']>('readMemory', request)
    }
    variables(args: DebugProtocol.VariablesArguments & Seq): Promise<DebugProtocol.Variable[]> {
        return this.sendParametricJson<DebugProtocol.Variable[]>('variables', args)
    }
    setVariable(args: DebugProtocol.SetVariableArguments & Seq): Promise<WithLength<DebugProtocol.SetVariableResponse['body']>> {
        return this.sendParametricJson<WithLength<DebugProtocol.SetVariableResponse['body']>>('setVariable', args)
    }
    scopes(args: DebugProtocol.ScopesArguments & Seq): Promise<DebugProtocol.Scope[]> {
        return this.sendParametricJson<DebugProtocol.Scope[]>('scopes', args)
    }
    async continue(req?: DebugProtocol.ContinueArguments & Seq): Promise<void> {
        await this.sendParametric('continue', req)
    }
    getStepInTargets(req: DebugProtocol.StepInTargetsArguments & Seq): Promise<DebugProtocol.StepInTarget[]> {
        return this.sendParametricJson<DebugProtocol.StepInTarget[]>('getStepInTargets', req)
    }
    async next(req: DebugProtocol.NextArguments & Seq): Promise<void> {
        await this.sendParametric('next', req)
    }
    async stepIn(args: DebugProtocol.StepInArguments & Seq): Promise<void> {
        await this.sendParametric('stepIn', args)
    }
    async stepOut(args: DebugProtocol.StepOutArguments & Seq): Promise<void> {
        await this.sendParametric('stepOut', args)
    }
    runningShaders(seq?: number): Promise<RunningShader[]> {
        return this.sendParametricJson<RunningShader[]>('runningShaders', { seq })
    }
    evaluate(args: DebugProtocol.EvaluateArguments & Seq): Promise<WithLength<DebugProtocol.EvaluateResponse['body']>> {
        return this.sendParametricJson<WithLength<DebugProtocol.EvaluateResponse['body']>>('evaluate', args)
    }
    setExpression(args: DebugProtocol.SetExpressionArguments & Seq): Promise<WithLength<DebugProtocol.SetExpressionResponse['body']>> {
        return this.sendParametricJson<WithLength<DebugProtocol.SetExpressionResponse['body']>>('setExpression', args)
    }
    dataBreakpointInfo(args: DebugProtocol.DataBreakpointInfoArguments & Seq): Promise<DebugProtocol.DataBreakpointInfoResponse['body']> {
        return this.sendParametricJson<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', args)
    }
    async clearDataBreakpoints(seq?: number): Promise<void> {
        await this.sendParametric('clearDataBreakpoints', { seq })
    }
    setDataBreakpoint(args: DebugProtocol.DataBreakpoint & Seq): Promise<Breakpoint> {
        return this.sendParametricJson<Breakpoint>('setDataBreakpoint', args)
    }
    completion(args: DebugProtocol.CompletionsArguments & Seq): Promise<DebugProtocol.CompletionItem[]> {
        return this.sendParametricJson<DebugProtocol.CompletionItem[]>('completion', args)
    }
    async noDebug(args: DebugProtocol.CancelArguments & Seq): Promise<void> {
        await this.sendParametric('noDebug', args)
    }
}

declare global {
    interface String {
        splitNoOrphans(separator: string | RegExp, limit?: number): string[]
    }
}

String.prototype.splitNoOrphans = function (separator: string | RegExp, limit?: number): string[] {
    const arr = this.split(separator, limit)
    while (arr[arr.length - 1] === '') {
        arr.pop()
    }
    return arr
}

export interface CommunicatorImpl extends vscode.Disposable {
    onConnected: Set<VoidFunction>
    onDisconnected: Set<VoidFunction>
    onMessage: Set<MessageCallback>

    disconnect(): void
    open(): Promise<void>

    sendCommand(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string>
    sendParametric(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string>
    sendParametricJson<T>(command: string, params: MapLike<string | number | boolean | null | undefined> | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<T>

    ensureConnected(): Promise<void>
    get isConnected(): boolean
}

/**
 * Handles re-creation of the socet connection when it is closed
 */
export class WebSocketContainer implements vscode.Disposable {
    protected ws: WebSocket | null = null
    onMessage = new Set<MessageCallback>()
    onConnected = new Set<VoidFunction>()
    onDisconnected = new Set<VoidFunction>()
    protected connected: Promise<void>
    private _resolveConnected!: () => void
    private _rejectConnected!: (reason?: any) => void
    private _endpoint!: URL

    constructor(defaultURL?: string | URL, open: boolean = true) {
        this.connected = new Promise<void>((resolve, reject) => {
            this._resolveConnected = resolve
            this._rejectConnected = reject
        })
        if (defaultURL) {
            this.endpoint = defaultURL
            if (open) {
                this.open()
            }
        }
    }

    get endpoint(): URL {
        return this.endpoint
    }

    set endpoint(value: URL | string) {
        const original = this._endpoint
        if (typeof value === 'string') {
            const parsed = URL.parse(value)
            if (parsed) {
                this._endpoint = parsed
            } else {
                throw URIError("Could not parse")
            }
        } else {
            this._endpoint = value
        }
        if (this._endpoint != original) {
            this.open()
        }
    }

    close() {
        this.ws?.close()
    }

    async open() {
        const config = vscode.workspace.getConfiguration('deshader.communicator')
        let remaining = config.get<number>("retries", 3)
        while (remaining-- > 0) {
            try {
                this.ws = new WebSocket(this._endpoint)
                this.ws.addEventListener('error', ev => {
                    if(remaining == 0){
                        this.ws!.onclose = null
                        this.disconnect(ev)
                    }
                    this.connected = new Promise((resolve, reject) => {
                        this._resolveConnected = resolve
                        this._rejectConnected = reject
                    })
                })
                this.ws.addEventListener('close', ev => {
                    this.ws!.onclose = null
                    this.disconnect(ev)
                })
                if (this.ws.readyState == WebSocket.OPEN) {
                    this.onConnected.forEach(l => l())
                    this._resolveConnected()
                } else {
                    this.ws!.addEventListener('open', () => {
                        const check = setInterval(() => {// workaround for readyState is not update immediately (browser bug/feature?)
                            if (this.ws?.readyState == WebSocket.OPEN) {
                                this.onConnected.forEach(l => l())
                                this._resolveConnected()
                            }
                            clearInterval(check)
                        }, config.get<number>("readyCheck", 800))
                    })
                }
                await this.connected;
                break;// success
            } catch (e) {
                if (remaining == 0) {
                    this._rejectConnected(e)
                }
            }
        }
        this.ws!.addEventListener('message', ev => this.onMessage.forEach(l => l(ev)))
    }

    async ensureConnected() {
        switch (this.ws?.readyState ?? WebSocket.CLOSED) {
            case WebSocket.CLOSED:
                await this.open()
                break
            case WebSocket.CONNECTING:
                await this.connected
                break
        }
    }

    get isConnected() {
        return this.ws?.readyState == WebSocket.OPEN
    }

    disconnect(reason?: any) {
        this.ws?.close(typeof reason === 'number' ? reason : undefined, typeof reason === 'string' ? reason : undefined)
        this.ws = null
        this._rejectConnected(reason)
        this.connected = new Promise((resolve, reject) => {
            this._resolveConnected = resolve
            this._rejectConnected = reject
        })
        this.onDisconnected.forEach(l => l())
    }

    dispose() {
        this.disconnect()
    }

    async send(data: string | Blob | ArrayBufferLike | ArrayBufferView): Promise<void> {
        await this.ensureConnected()
        this.ws?.send(data)
    }
}

export class WSCommunicator extends WebSocketContainer implements CommunicatorImpl {
    comm: Communicator
    pendingRequests: MapLike<{
        promise: Promise<any> | null,
        name?: string,
        resolve: (response: Blob) => void
        reject: (response: string) => void
    }> = {};

    constructor(comm: Communicator, open = true) {
        super(comm.endpointURL || undefined, open)
        this.comm = comm
    }

    close() {
        this.ws?.close()
    }

    async open() {
        await super.open()
        this.connected.then(() => this.comm.emit(Events.connected))
        this.ws!.addEventListener('message', (event) => {
            const responseLines: string[] = splitStringToNParts(event.data, '\n', 3)//0: status, 1: echoed command / seq, 2: body
            if (responseLines[0].startsWith('600')) {// event (pushed by Deshader library)
                this.comm.emit(Events[responseLines[1]], responseLines[2])
                this.comm.output.appendLine(event.data)
            }
            else {
                let found = false
                for (let [command, actions] of Object.entries(this.pendingRequests)) {
                    if (responseLines.length > 1 && responseLines[1] == command) {
                        this.comm.output.appendLine(responseLines[0])
                        this.comm.output.appendLine(actions.name ?? responseLines[1])
                        this.comm.output.appendLine(responseLines[2])
                        found = true

                        const resp = responseLines[2]
                        this.comm.emit(Events.message, resp)
                        if (responseLines[0].startsWith('202')) {// success
                            actions.resolve(new Blob([resp]))
                        }
                        else if (responseLines[0].startsWith('500')) {// error
                            actions.reject(responseLines[2].slice(6))// skip "error." prefix
                        } else {
                            actions.reject(resp)
                        }
                    }
                }
                if (!found) { this.comm.output.appendLine("Could not process: " + event.data) }
            }
        })
        this.ws!.addEventListener('error', (event) => {
            this.comm.output.appendLine("WebSocket connection has been closed by an error")
            this.comm.emit(Events.error, event)
        })
        this.ws!.addEventListener('close', (event) => {
            this.comm.output.appendLine("WebSocket connection has been closed " + (event.wasClean ? "clean" : "unclean") + " with reason (" + event.code + "): " + event.reason)
            this.comm.emit(Events.close, event)
        })
    }

    sendParametricJson<T>(command: string, params?: MapLike<string | number | boolean | null | undefined> | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<T> {
        const str = this.sendParametric(command, params, body)
        return str.then((response) => JSON.parse(response) as T)
    }

    sendParametric(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string> {
        let i = 0
        let seq: number | undefined
        if (typeof params !== 'undefined') {
            for (let [key, value] of Object.entries(params)) {
                if (i++ == 0) {
                    command += '?'
                } else {
                    command += '&'
                }
                command += encodeURIComponent(key)
                if (typeof value !== 'undefined') {
                    command += '=' + encodeURIComponent(value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value))
                }
                if (key == "seq") {
                    seq = value
                }
            }
        }
        return this.sendCommand(command, body, seq)
    }

    shown = 0
    async sendCommand(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView, seq?: number): Promise<string> {
        if (!this.isConnected) {
            if (this.shown++ < 3) {
                const item = await vscode.window.showErrorMessage("Deshader command server is not connected", "Connect")
                if (item) {
                    vscode.commands.executeCommand("deshader.connect")
                }

            }
            throw new Error("Not connected to Deshader command server")
        }
        const id = seq ?? command
        const didntExist = typeof this.pendingRequests[id] === 'undefined'
        if (didntExist) {
            const p = new Promise<string>((_resolve, _reject) => {
                const t = setTimeout(() => {
                    _reject(new Error('Request timed out'))
                    delete this.pendingRequests[id]
                }, 5000)//TODO put timeout in config
                const self = this
                this.pendingRequests[id] = {
                    promise: null,
                    resolve(response) {
                        clearTimeout(t)
                        _resolve(response.text())
                        delete self.pendingRequests[id]
                    },
                    async reject(response) {
                        clearTimeout(t)
                        _reject(response)
                        delete self.pendingRequests[id]
                    },
                    name: seq ? command : undefined
                }
            })
            this.pendingRequests[id].promise = p
            if ((this.ws?.readyState ?? WebSocket.CONNECTING) == WebSocket.CONNECTING) { await this.connected }
            this.ws!.send(new Blob([command, ...body ? [body] : []]))
            this.comm.output.appendLine(`${command}\n${body ?? ""}`)
            return await p
        } else {
            this.comm.output.appendLine(`Duplicate send request ${seq ?? ""} ${command} ${body ?? ""}`)
            return await this.pendingRequests[id].promise
        }
    }
}

function splitStringToNParts(str: string, separator: string, n: number) {
    let parts: string[] = []
    let temp = ''
    let count = 0

    for (let i = 0; i < str.length; i++) {
        if (str.substring(i, i + separator.length) === separator) {
            if (count < n - 1) {
                parts.push(temp)
                temp = ''
                count++
                i += separator.length - 1
            } else {
                temp += str[i]
            }
        } else {
            temp += str[i]
        }
    }

    parts.push(temp)

    return parts
}
