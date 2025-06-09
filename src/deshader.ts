/** 
 * @todo inject deshader into any debugging session
 * @todo support shader analysis without a running process
*/
import { MapLike } from 'typescript'
import * as vscode from 'vscode'
import { EventEmitter } from 'events'
import { DebugProtocol } from '@vscode/debugprotocol'
import Commands from './commands'

export const DeshaderSchemes = ['deshader', 'deshaders', 'deshaderws', 'deshaderwss'] as const
export const RawSchemes = ['http', 'https', 'ws', 'wss'] as const
export type RawScheme = typeof RawSchemes[number]
export const DeshaderSchemesAndRaw = [...DeshaderSchemes, ...RawSchemes] as const
export type DeshaderScheme = typeof DeshaderSchemes[number]
export type DeshaderOrRawScheme = typeof DeshaderSchemesAndRaw[number]
export enum ConnectionState { Connecting, Connected, Disconnected }
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
        /** Step ID within the source file. Not used by the debug adapter */
        step: number,
        /** Running shader ID */
        thread: number,
    },
    stopOnBreakpoint: {
        ids: number[],//breakpoint IDs list,
        // Running shader ID
        thread: number,
    },
    stopOnDataBreakpoint: number,
    stopOnFunction: String,
    breakpoint: BreakpointEvent,
    // type, text, source, line, column
    output: ["prio" | "out" | "err", DebugProtocol.OutputEvent['body']['group'], string, number, number]
    end: undefined
}
/** Identifies a single running shader "thread" and some meta information about the shader */
export type RunningShader = {
    /// DAP "threadId", Deshader "RunningShader.Locator.impl"
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
export type Settings = {
    logIntoResponses: boolean,
    singleChunkShader: boolean,
    stackTraces: boolean,
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
export type PossibleBreakpoints = { breakpoints: BreakpointLocation[] }

export type StackFrame = SourceToPath<DebugProtocol.StackFrame>
export type StackTraceResponse = {
    stackFrames: StackFrame[],
    totalFrames: number
}
export type WithLength<T> = T & { length?: number }
export type Seq = { seq?: number }
export type PathRequest = { path: string } & Seq
export type ListRequest = { path?: string, recursive?: boolean, untagged?: boolean } & Seq
export type Body = string | ArrayBufferLike | Blob | ArrayBufferView
/**
 * Content should be in reqest body
 */
export type SaveRequest = PathRequest & { compile: boolean, link: boolean }
type MessageCallback = (event: MessageEvent) => void

const ANSI_ESCAPE_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
const BINARY_NOTICE = '[binary data]'

/**
 * Communicates through WS or HTTP with a running Deshader instance
 * Proxies both the virtual file system and the debugger
 */
export class Communicator extends EventEmitter implements vscode.Disposable {
    output: vscode.OutputChannel
    trace = false
    private impl: ICommunicatorImpl | null = null
    private _endpoint: URL | null = null
    private _scheme: DeshaderOrRawScheme = 'deshader'
    private _onConnected = new Set<VoidFunction>()
    private _onDisconnected = new Set<VoidFunction>()
    private _onMessage = new Set<MessageCallback>()
    private _settings: Settings = {
        logIntoResponses: true,
        singleChunkShader: true,
        stackTraces: true,
    }

    constructor(output: vscode.OutputChannel, defaultURL?: string | URL | vscode.Uri, open = true) {
        super()
        if (defaultURL)
            this.endpointURL = defaultURL
        this.output = output
        if (open && defaultURL) {
            this.open()
        }
        this.updateConfig()
        vscode.workspace.onDidChangeConfiguration(e =>
            (e.affectsConfiguration('deshader.tracing') || e.affectsConfiguration('deshader.debugging')) && this.updateConfig()
        )
    }

    private updateConfig() {
        const tracing = vscode.workspace.getConfiguration('deshader.tracing')
        const debugging = vscode.workspace.getConfiguration('deshader.debugging')
        this.trace = tracing.get<boolean>('enable', false)
        this._settings.stackTraces = this.trace && tracing.get<boolean>('stacks', false)
        this._settings.logIntoResponses = this.trace && tracing.get<boolean>('libraryLogs', false)
        this._settings.singleChunkShader = debugging.get<boolean>('singleChunk', true)

        if (this.isConnected) {
            this.settings(this._settings)
        }
    }

    /**
     * Always returns a {@link URL} object with {@link RawScheme} as protocol.
     */
    get endpointURL(): URL | null {
        return this._endpoint
    }

    /**
     * Accepts {@link RawScheme} or {@link DeshaderScheme} in the form of a {@link string}, {@link URL} or {@link vscode.Uri}.
     */
    set endpointURL(value: string | URL | vscode.Uri) {
        value = value instanceof vscode.Uri ? value : vscode.Uri.parse(value.toString())
        const raw = toRawURL(value)
        const rawString = raw.toString()
        if (this._endpoint == null || rawString.startsWith(this._endpoint.origin)) {
            this._scheme = value.scheme as DeshaderOrRawScheme
            this._endpoint = new URL(rawString)
            this.updateImpl()
        }
    }

    get onConnected() {
        if (this.impl)
            return this.impl.onConnected
        return this._onConnected
    }
    get onDisconnected() {
        if (this.impl)
            return this.impl.onDisconnected
        return this._onDisconnected
    }
    get onMessage() {
        if (this.impl)
            return this.impl.onMessage
        return this._onMessage
    }
    get scheme() {
        return this._scheme
    }

    shown = 0
    showing = false
    private async updateImpl() {
        if (this.impl) {
            this.impl.dispose()
            this._onMessage = this.impl.onMessage
            this._onConnected = this.impl.onConnected
            this._onDisconnected = this.impl.onDisconnected
        }
        if (this._endpoint) {
            const impl = protocolToImpl(this._endpoint.protocol as WithColon<RawScheme>)
            this.impl = new impl(this, false)
            this.impl.onConnected = this._onConnected
            this.impl.onDisconnected = this._onDisconnected
            this.impl.onMessage = this._onMessage
            await this.impl.open()
            this.showing = false
            this.shown = 0
            this.settings(this._settings)
        } else {
            if (this.shown++ < 3 && !this.showing) {
                this.showing = true
                vscode.window.showErrorMessage("Connect to a Deshader command server first", "Connect").then((item) => {
                    this.showing = false
                    if (item) {
                        vscode.commands.executeCommand(Commands.connect)
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
    emit<T extends keyof typeof Events>(eventName: (typeof Events)[T], arg?: string | Blob | Event): boolean {
        return super.emit(eventName, arg)
    }

    /**
     * Get host name without port
     */
    getHost(): string | undefined {
        return this._endpoint?.hostname
    }

    disconnect(): void {
        this.impl?.disconnect()
    }
    open(): void {
        if (this.impl) {
            this.impl.open()
        }
        else {
            this.updateImpl()
        }
    }

    get isConnected(): boolean {
        return this.impl?.isConnected || false
    }

    get isConnecting(): boolean {
        return this.impl?.isConnecting || false
    }

    get connectionState(): ConnectionState {
        return this.impl?.connectionState ?? ConnectionState.Disconnected
    }

    send<OutputString = true>(command: string, body?: Body, seq?: number, outputString: boolean | OutputString = true): Promise<OutputString extends false ? Blob : string> {
        if (!this.impl) {
            this.updateImpl()
        }
        return this.impl!.sendCommand(command, body, seq, outputString) as Promise<OutputString extends false ? Blob : string>
    }
    sendParametric<OutputString = true>(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: Body, outputString: boolean | OutputString = true): Promise<OutputString extends false ? Blob : string> {
        if (!this.impl) {
            this.updateImpl()
        }
        return this.impl!.sendParametric(command, params, body, outputString) as Promise<OutputString extends false ? Blob : string>
    }
    sendParametricJson<T>(command: string, params: MapLike<string | number | boolean | null | undefined> | object, body?: Body): Promise<T> {
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
    async mkdir(req: PathRequest): Promise<void> {
        await this.sendParametric('mkdir', req)
    }
    async readFile(req: PathRequest): Promise<Blob> {
        return this.sendParametric('readFile', req, undefined, false)
    }
    readLink(_: PathRequest): Promise<string> {
        throw new Error("Method not implemented.")
    }
    async savePhysical(req: SaveRequest, content: Body): Promise<void> {
        await this.sendParametric('savePhysical', req, content)
    }
    async saveVirtual(req: SaveRequest, content: Body): Promise<void> {
        await this.sendParametric('saveVirtual', req, content)
    }
    /**
     * Tries to save physically, if it fails, it saves virtually
     */
    async save(req: SaveRequest, content: Body): Promise<void> {
        await this.sendParametric('save', req, content, false)
    }

    /**
     * @returns The new full path for the file
     */
    rename(req: { from: string, to: string } & Seq): Promise<string> {
        return this.sendParametric('rename', req)
    }

    async untag(req: PathRequest): Promise<void> {
        await this.sendParametric('untag', req)
    }

    /**
     * Get or set settings variable(s)
     * @returns Settings variables separated by newline in the format key=value
     */
    settings(req?: Partial<Settings>): Promise<string> {
        return this.sendParametric('settings', req)
    }

    /**
     * Translates a path from the real to virtual file system
     * @param req An absolute filesystem path
     * @returns The path in the virtual file system
     */
    translatePath(req: PathRequest): Promise<string> {
        return this.sendParametric('translatePath', req)
    }

    async clients(req?: Seq): Promise<string[]> {
        return (await this.sendParametric('clients', req)).splitNoOrphans('\n')
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
    async state(req?: Seq): Promise<State> {
        return this.sendParametricJson<State>('state', req ?? {})
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
    async pause(req: DebugProtocol.PauseArguments & Seq): Promise<void> {
        await this.sendParametric('pause', req)
    }
    async pauseMode(args: { single: boolean } & Seq): Promise<void> {
        await this.sendParametric('pauseMode', args)
    }
    possibleBreakpoints(args: BreakpointLocation & Seq): Promise<PossibleBreakpoints> {
        return this.sendParametricJson<PossibleBreakpoints>('possibleBreakpoints', args)
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
    async restart(args: DebugProtocol.RestartArguments & Seq): Promise<void> {
        await this.sendParametric('restart', args)
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
        indexOfOrNull(searchValue: string, fromIndex?: number): number | null
    }
}

String.prototype.splitNoOrphans = function (separator: string | RegExp, limit?: number): string[] {
    const arr = this.split(separator, limit)
    while (arr[arr.length - 1] === '') {
        arr.pop()
    }
    return arr
}

String.prototype.indexOfOrNull = function (searchValue: string, fromIndex?: number): number | null {
    const i = this.indexOf(searchValue, fromIndex)
    return i == -1 ? null : i
}

export interface ICommunicatorImpl extends vscode.Disposable {
    onConnected: Set<VoidFunction>
    onDisconnected: Set<VoidFunction>
    onMessage: Set<MessageCallback>

    disconnect(): void
    open(): Promise<void>

    sendCommand<OutputString = true>(command: string, body?: Body, seq?: number, outputString?: OutputString): Promise<OutputString extends false ? Blob : string>
    sendParametric<OutputString = true>(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: Body, outputString?: OutputString): Promise<OutputString extends false ? Blob : string>
    sendParametricJson<T>(command: string, params: MapLike<string | number | boolean | null | undefined> | object, body?: Body): Promise<T>

    ensureConnected(): Promise<void>
    get isConnected(): boolean
    get isConnecting(): boolean
    get connectionState(): ConnectionState
    get scheme(): DeshaderScheme,
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

    constructor(defaultURL?: URL, open: boolean = true) {
        this.connected = new Promise<void>((resolve, reject) => {
            this._resolveConnected = resolve
            this._rejectConnected = reject
        })
        if (defaultURL) {
            this._endpoint = defaultURL
            if (open) {
                this.open()
            }
        }
    }

    get endpoint(): URL {
        return this._endpoint
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
                    if (remaining == 0 && this.ws) {
                        this.ws.onclose = null
                        this.disconnect(ev)
                    }
                    this.connected = new Promise((resolve, reject) => {
                        this._resolveConnected = resolve
                        this._rejectConnected = reject
                    })
                })
                this.ws.addEventListener('close', ev => {
                    if (this.ws) {
                        this.ws.onclose = null
                        this.disconnect(ev)
                    }
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
                await this.connected
                break// success
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

    get isConnecting() {
        return this.ws?.readyState == WebSocket.CONNECTING
    }

    get connectionState() {
        switch (this.ws?.readyState) {
            case WebSocket.CONNECTING:
                return ConnectionState.Connecting
            case WebSocket.OPEN:
                return ConnectionState.Connected
            default:
                return ConnectionState.Disconnected
        }
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

export class WSCommunicator extends WebSocketContainer implements ICommunicatorImpl {
    comm: Communicator
    pendingRequests: MapLike<{
        promise: Promise<any> | null,
        name?: string,
        resolve: (response: Blob | string) => void
        reject: (response: string) => void
    }> = {};

    constructor(comm: Communicator, open = true) {
        super(comm.endpointURL || undefined, open)
        this.comm = comm
    }

    close() {
        this.ws?.close()
    }

    get scheme() {
        return normalizeScheme(this.endpoint.protocol.slice(0, this.endpoint.protocol.length - 1) as DeshaderOrRawScheme)
    }

    async open() {
        await super.open()
        this.showing = false
        this.shown = 0

        this.connected.then(() => this.comm.emit(Events.connected))
        this.ws!.addEventListener('message', async (event: MessageEvent<Blob | string>) => {
            // TODO: do not toString
            const responseLines: Blob[] = await splitBlob(event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'text/plain' }), '\n'.charCodeAt(0), 3)//0: status, 1: echoed command / seq, 2: body
            const code = await responseLines[0].text()
            const messCommand = await responseLines[1].text()
            if (code.startsWith('600')) {// event (pushed by Deshader library)
                const text = await responseLines[2].text()// TODO how to handle non-text events?
                this.comm.emit(Events[messCommand], text)
                if (this.comm.trace) {
                    this.comm.output.appendLine(code)
                    this.comm.output.appendLine(messCommand)
                    this.comm.output.appendLine(text.replace(ANSI_ESCAPE_REGEX, ''))
                }
            }
            else {
                let found = false
                for (let [command, actions] of Object.entries(this.pendingRequests)) {
                    if (responseLines.length > 1 && messCommand == command) {
                        if (this.comm.trace) {
                            this.comm.output.appendLine(code)
                            this.comm.output.appendLine(actions.name ?? messCommand)
                            const body = event.data instanceof Blob ? BINARY_NOTICE : await responseLines[2].text().then(text => text.replace(ANSI_ESCAPE_REGEX, ''))
                            this.comm.output.appendLine(body)
                            this.comm.emit(Events.message, body)
                        }
                        found = true

                        if (code.startsWith('202')) {// success
                            actions.resolve(responseLines[2])
                        }
                        else if (code.startsWith('500')) {// error
                            actions.reject(typeof event.data == 'string' ? await responseLines[2].slice(6).text() : BINARY_NOTICE)// skip "error." prefix
                        } else {
                            actions.reject(code)
                        }
                    }
                }
                if (!found) { this.comm.output.appendLine("Could not process: " + (typeof event.data === 'string' ? event.data : BINARY_NOTICE)) }
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

    sendParametricJson<T>(command: string, params?: MapLike<string | number | boolean | null | undefined> | object, body?: Body): Promise<T> {
        const str = this.sendParametric(command, params, body, true)
        return str.then((response) => {
            try {
                return JSON.parse(response) as T
            } catch (e) {
                this.comm.output.appendLine("Failed to parse JSON: " + response)
                throw new Error("Failed to parse JSON: " + response)
            }
        })
    }

    sendParametric<OutputString = true>(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: Body, outputString: boolean | OutputString = true): Promise<OutputString extends false ? Blob : string> {
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
        return this.sendCommand(command, body, seq, outputString)
    }

    shown = 0
    showing = false
    async sendCommand<OutputString = true>(command: string, body?: Body, seq?: number, outputString: boolean | OutputString = true): Promise<OutputString extends false ? Blob : string> {
        if (this.connectionState == ConnectionState.Disconnected) {
            if (this.shown++ < 3 && !this.showing) {
                this.showing = true
                const item = await vscode.window.showErrorMessage("Deshader command server is not connected", "Connect")
                this.showing = false
                if (item) {
                    vscode.commands.executeCommand(Commands.connect)
                }

            }
            throw new Error("Not connected to Deshader command server")
        }
        const id = seq ?? command
        const didntExist = typeof this.pendingRequests[id] === 'undefined'
        if (didntExist) {
            const p = new Promise<string | Blob>((_resolve, _reject) => {
                const t = setTimeout(() => {
                    _reject(new Error('Request timed out'))
                    delete this.pendingRequests[id]
                }, 5000)//TODO put timeout in config
                const self = this
                this.pendingRequests[id] = {
                    promise: null,
                    resolve(response) {
                        clearTimeout(t)
                        _resolve(typeof response === 'string' ?
                            outputString ? response : new Blob([response]) :
                            outputString ? response.text() : response
                        )
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
            this.comm.output.appendLine(`${command}\n${body ?? ""}`)
            this.ws!.send(new Blob([command, ...(body ? ["\0", body] : [])]))
            return p as Promise<OutputString extends false ? Blob : string>
        } else {
            this.comm.output.appendLine(`Duplicate send request ${seq ?? ""} ${command} ${body ?? ""}`)
            return this.pendingRequests[id].promise
        }

    }
}

export function isTagged(path: string): boolean {
    return !path.startsWith("/untagged")
}

export function normalizeScheme(scheme: DeshaderOrRawScheme): DeshaderScheme {
    if (DeshaderSchemes.includes(scheme as DeshaderScheme)) {
        return scheme as DeshaderScheme
    } else switch (scheme) {
        case 'http':
            return 'deshader'
        case 'https':
            return 'deshaders'
        case 'ws':
            return 'deshaderws'
        case 'wss':
            return 'deshaderwss'
        default:
            throw new Error(`Unknown scheme ${scheme}`)
    }
}

export type WithColon<T> = T extends string ? `${T}:` : never
export function toRawURL(url: vscode.Uri | URL | string): vscode.Uri {
    const uri = url instanceof vscode.Uri ? url : vscode.Uri.parse(typeof url === 'string' ? url : url.toString())
    if (RawSchemes.includes(uri.scheme as RawScheme)) {
        return uri
    } else return uri.with({ scheme: toRawScheme(uri.scheme as DeshaderScheme) })
}

function toRawScheme(scheme: DeshaderScheme): RawScheme {
    switch (scheme) {
        case 'deshader':
            return 'http'
        case 'deshaders':
            return 'https'
        case 'deshaderws':
            return 'ws'
        case 'deshaderwss':
            return 'wss'
        default:
            throw new Error(`Unknown Deshader scheme ${scheme}`)
    }
}

function protocolToImpl(protocol: WithColon<RawScheme>): new (comm: Communicator, open?: boolean) => ICommunicatorImpl {
    switch (protocol) {
        case 'ws:':
        case 'wss:':
            return WSCommunicator
        default:
            throw new Error(`Unimplemented protocol ${protocol}`)
    }
}


async function splitBlob(str: Blob, separator: number, n: number, chunk = 500) {
    let parts: Blob[] = []

    let last = 0
    for (let i = 0; i < str.size; i += chunk) {
        const start = i * chunk
        const part = await str.slice(start, (i + 1) * chunk).bytes()
        for (let x = 0; x < part.length; x++) {
            if (part[x] == separator) {
                parts.push(str.slice(last, start + x, str.type))
                last = start + x + 1
                if (parts.length == n - 1) {
                    parts.push(str.slice(last, str.size, str.type))
                }
            }
        }
    }

    return parts
}