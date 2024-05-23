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
    lsp?: number,//port number
}
export type Config = { protocol: "ws" | "wss" | "http" | "https", host: string, port: number }
export type AttachArguments = {
    connection: Config
    showDebugOutput?: LaunchArguments['showDebugOutput']
    stopOnEntry?: LaunchArguments['stopOnEntry']
}
export type LaunchArguments = {
    /** An absolute path to the "program" to debug. */
    program: string
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean
    showDebugOutput?: boolean
    args: string[]
    cwd?: string
    env?: { [key: string]: string }
    console?: 'debugConsole' | 'integratedTerminal' | 'externalTerminal'
    connection?: Config
    showDevDebugOutput?: boolean
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
/**
 * Communicates through WS or HTTP with a running Deshader instance
 * Proxies both the virtual file system and the debugger
 */
export abstract class Communicator extends EventEmitter implements vscode.Disposable {
    uri: vscode.Uri
    output: vscode.OutputChannel
    connected: Promise<void>
    protected _resolveConnected!: () => void
    protected _rejectConnected!: () => void
    abstract ensureConnected(): Promise<void>

    constructor(uri: vscode.Uri, output: vscode.OutputChannel, open = true) {
        super()
        this.uri = uri
        this.output = output
        this.connected = new Promise((resolve, reject) => {
            this._resolveConnected = resolve
            this._rejectConnected = reject
        })
        if (open) {
            this.open()
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

    static fromUri(uri: vscode.Uri, output: vscode.OutputChannel, open = true): Communicator {
        switch (uri.scheme) {
            case 'ws':
            case 'wss':
                return new WSCommunicator(uri, output, open)
            default:
                throw new Error(`Unknown scheme ${uri.scheme}`)
        }
    }

    static fromConfig(config: Config, output: vscode.OutputChannel, open = true) {
        switch (config.protocol) {
            case "ws":
            case "wss":
                return new WSCommunicator(vscode.Uri.from({
                    scheme: config.protocol,
                    authority: `${config.host}:${config.port}`
                }), output, open)
            default:
                throw new Error(`Unknown protocol ${config.protocol}`)
        }
    }

    /**
     * Get host name without port
     */
    getHost(): string {
        return this.uri.authority.split(':', 2)[0]
    }

    abstract disconnect(): void
    abstract open(): void

    abstract send(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string>
    abstract sendParametric(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string>
    abstract sendParametricJson<T>(command: string, params: MapLike<string | number | boolean | null | undefined> | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<T>

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

    async languageServerStart(req: { port?: number } & Seq = {}): Promise<number | null> {
        return parseInt(await this.sendParametric('languageServerStart', req)) || 0
    }

    async languageServerStop(seq?: number): Promise<void> {
        await this.sendParametric('languageServerStop', { seq })
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

export class WSCommunicator extends Communicator {
    ws!: WebSocket
    pendingRequests: MapLike<{
        promise: Promise<any> | null,
        name?: string,
        resolve: (response: Blob) => void
        reject: (response: string) => void
    }> = {};

    constructor(uri: vscode.Uri, output: vscode.OutputChannel, open = true) {
        super(uri, output, open)
    }

    open() {
        if (this.ws) {// connected previously
            if (this.ws.readyState == WebSocket.OPEN) {
                this._resolveConnected()
                return
            }

            this.connected = new Promise((resolve, reject) => {
                this._resolveConnected = resolve
                this._rejectConnected = reject
            })
        }
        this.ws = new WebSocket(this.uri.toString())
        this.ws.onopen = () => {
            this.output.appendLine('WebSocket connection established')
            this.emit(Events.connected)
            this._resolveConnected()
        }
        this.ws.addEventListener('message', (event) => {
            const responseLines: string[] = splitStringToNParts(event.data, '\n', 3)//0: status, 1: echoed command / seq, 2: body
            if (responseLines[0].startsWith('600')) {// event (pushed by Deshader library)
                this.emit(Events[responseLines[1]], responseLines[2])
                this.output.appendLine(event.data)
            }
            else {
                let found = false
                for (let [command, actions] of Object.entries(this.pendingRequests)) {
                    if (responseLines.length > 1 && responseLines[1] == command) {
                        this.output.appendLine(responseLines[0])
                        this.output.appendLine(actions.name ?? responseLines[1])
                        this.output.appendLine(responseLines[2])
                        found = true

                        const resp = responseLines[2]
                        this.emit(Events.message, resp)
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
                if (!found)
                    this.output.appendLine("Could not process: " + event.data)
            }
        })
        this.ws.addEventListener('error', (event) => {
            this.output.appendLine("WebSocket connection has been closed by an error")
            this.emit(Events.error, event)
            this._rejectConnected()
        })
        this.ws.addEventListener('close', (event) => {
            this.output.appendLine("WebSocket connection has been closed " + (event.wasClean ? "clean" : "unclean") + " with reason (" + event.code + "): " + event.reason)
            this.emit(Events.close, event)
            this._rejectConnected()
        })
    }

    async ensureConnected() {
        switch (this.ws.readyState) {
            case WebSocket.CLOSED:
                this.open()
                await this.connected
                break
            case WebSocket.CONNECTING:
                await this.connected
                break
        }
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
        return this.send(command, body, seq)
    }

    async send(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView, seq?: number): Promise<string> {
        const id = seq ?? command
        if (typeof this.pendingRequests[id] === 'undefined') {
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
            if (this.ws.readyState == WebSocket.CONNECTING) await this.connected
            this.ws.send(new Blob([command, ...body ? [body] : []]))
            this.output.appendLine(`${command}\n${body ?? ""}`)
            return await p
        } else {
            this.output.appendLine(`Duplicate send request ${seq ?? ""} ${command} ${body ?? ""}`)
            return await this.pendingRequests[id].promise
        }
    }

    disconnect() {
        this.ws.close()
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
