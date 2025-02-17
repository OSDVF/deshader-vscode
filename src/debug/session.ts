import { DebugProtocol } from '@vscode/debugprotocol'
import {
    logger,
    LoggingDebugSession,
    Event,
    StoppedEvent, InitializedEvent, TerminatedEvent, BreakpointEvent, OutputEvent,
    ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
    Thread, StackFrame, Scope, Source, MemoryEvent, Logger, ErrorDestination
} from '@vscode/debugadapter'
import { Communicator, Events, EventArgs, RunningShader, LaunchArguments, AttachArguments, Breakpoint, BreakpointEvent as DeshaderBreakpointEvent, DeshaderScheme } from '../deshader'
import * as vscode from 'vscode'
import { DebugSessionBase } from 'conditional-debug-session'
import { basename, dirname, join } from 'path-browserify'
import { run, isRunning, terminate } from '../RPC'
import { unknownToString } from '../format'
import { nodeOnly } from '../macros'
let child_process: typeof import('child_process')
nodeOnly('child_process')?.then(cp => child_process = cp)
let fs: typeof import('fs')
nodeOnly('fs')?.then(f => fs = f)
const isWindows = navigator.userAgent.includes('Win')

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments, LaunchArguments { }

interface IAttachRequestArguments extends DebugProtocol.AttachRequestArguments, AttachArguments { }

/**
 * Contains all debug sessions that are currently running
 */
export const debugSessions = new Set<vscode.DebugSession>()
export const deshaderSessions = new Set<vscode.DebugSession>()
vscode.debug.onDidStartDebugSession(s => {
    debugSessions.add(s)
    if (s.type == 'deshader') {
        deshaderSessions.add(s)
    }
})
vscode.debug.onDidTerminateDebugSession(s => {
    debugSessions.delete(s)
    if (s.type == 'deshader') {
        deshaderSessions.delete(s)
    }
})

/**
 * Deshader debug adapter
 */
export class DebugSession extends DebugSessionBase {
    /**
     * Connection string that will be used when no connection is specified
     */
    static TYPE: 'deshader' = 'deshader'
    public static DEFAULT_CONNECTION = "ws://127.0.0.1:8082";
    public static DEFAULT_LIBRARY_PATH = isWindows ? "deshader.dll" : navigator.userAgent.includes('Mac') ? "libdeshader.dylib" : "libdeshader.so"
    public static DEFAULT_LAUNCHER_PATH = "deshader-run"
    private static _INSERT_LIBRARY_ENV = isWindows ? "PATH" : navigator.userAgent.includes('Mac') ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"
    private static _REPLACED_DLL = "OpenGL32.dll"

    public shaders: RunningShader[] = [];
    /**
     * index into this.shaders
     */
    public currentShader = 0;
    public outputChannel: vscode.OutputChannel | null = null;
    public singlePauseMode = false;

    /**
     * Resolves when the connection is established after the launch or attach request
     */
    public connected: Promise<void>

    private _comm: Communicator
    private _target: ReturnType<typeof child_process.spawn> | null = null

    private abortTarget = new AbortController();
    private _connected!: { resolve: () => void, reject: (reason?: any) => void }

    private _cancellationTokens = new Map<number, boolean>();

    private _reportProgress = false;
    private _progressId = 10000;
    private _cancelledProgressId: string | undefined = undefined;
    private _isProgressCancellable = true;

    private _valuesInHex = false;
    private _useInvalidatedEvent = false;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor(comm: Communicator, outputChannel: vscode.OutputChannel | null = null) {
        super()
        this.outputChannel = outputChannel
        this._comm = comm
        this.connected = new Promise<void>((res, rej) => {
            this._connected = { resolve: res, reject: rej }
        })

        // this debugger uses zero-based lines and columns
        if (this instanceof LoggingDebugSession) {
            this.setDebuggerLinesStartAt1(false)
            this.setDebuggerColumnsStartAt1(false)

        }
        this.setupEvents()
        this.setDebuggerPathFormat('deshader') // Everything other that 'path' is considered as an URI
    }

    setupEvents() {
        // setup event handlers
        this._comm.onJson<'stop'>(Events.stop, params => {
            if (params.step == 0) {
                this.sendEvent(new StoppedEvent('entry', params.shader))
            } else { this.sendEvent(new StoppedEvent('step', params.shader)) }
        })
        this._comm.onJson<'stopOnBreakpoint'>(Events.stopOnBreakpoint, (params) => {
            this.sendEvent(new Event('stopped', <DebugProtocol.StoppedEvent['body']>({ reason: 'breakpoint', threadId: params.shader, hitBreakpointIds: params.ids })))
        })
        this._comm.onJson<'stopOnDataBreakpoint'>(Events.stopOnDataBreakpoint, (threadID) => {
            this.sendEvent(new StoppedEvent('data breakpoint', threadID))
        })
        this._comm.onJson<'breakpoint'>(Events.breakpoint, (event: DeshaderBreakpointEvent) => {
            this.sendEvent(new BreakpointEvent(event.reason, this.convertDebuggerBreakpointToClient(event.breakpoint)))
        })
        this._comm.onJson<'invalidated'>(Events.invalidated, (event) => {
            if (this._useInvalidatedEvent) {
                this.sendEvent(new InvalidatedEvent(event.areas, event.threadId, event.stackFrameId))
            }
        })
        this._comm.onJson<'output'>(Events.output, (args: EventArgs['output']) => {
            const [type, text, source, line, column] = args

            let category: string
            switch (type) {
                case 'prio': category = 'important'; break
                case 'out': category = 'stdout'; break
                case 'err': category = 'stderr'; break
                default: category = 'console'; break
            }
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category)

            if (text === 'start' || text === 'startCollapsed' || text === 'end') {
                e.body.group = text
                e.body.output = `group-${text}\n`
            }

            e.body.source = this.pathToSource(source)
            e.body.line = this.convertDebuggerLineToClient(line)
            e.body.column = this.convertDebuggerColumnToClient(column)
            this.sendEvent(e)
        })
        this._comm.on<'end'>(Events.end, () => {
            this.sendEvent(new TerminatedEvent())
        })
    }

    public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {
        this.outputChannel?.appendLine(`sendRequest ${command} ${JSON.stringify(args)}`)
        super.sendRequest(command, args, timeout, cb)
    }

    public sendEvent(event: DebugProtocol.Event): void {
        this.outputChannel?.appendLine(`sendEvent ${event.event} ${JSON.stringify(event.body)}`)
        super.sendEvent(event)
    }

    public sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string | undefined, variables?: any, dest?: ErrorDestination | undefined): void {
        this.outputChannel?.appendLine(`sendErrorResponse ${response.command} ${codeOrMessage}`)
        super.sendErrorResponse(response, codeOrMessage, format, variables, dest)
    }

    public sendResponse(response: DebugProtocol.Response): void {
        this.outputChannel?.appendLine(`sendResponse ${response.command} ${JSON.stringify(response.body)}`)
        super.sendResponse(response)
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): Promise<void> {
        if (args.supportsProgressReporting) {
            this._reportProgress = true
        }
        if (args.supportsInvalidatedEvent) {
            this._useInvalidatedEvent = true
        }

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {}

        // the adapter implements the configurationDone request.
        response.body.supportsConfigurationDoneRequest = true

        // make VS Code use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true

        // make VS Code show a 'step back' button
        response.body.supportsStepBack = false

        // make VS Code support data breakpoints
        response.body.supportsDataBreakpoints = true

        // make VS Code support completion in REPL
        response.body.supportsCompletionsRequest = true
        response.body.completionTriggerCharacters = ["."]

        // make VS Code send cancel request
        response.body.supportsCancelRequest = false

        // make VS Code send the breakpointLocations request
        response.body.supportsBreakpointLocationsRequest = true

        // make VS Code provide "Step in Target" (selecting stack frame) functionality
        response.body.supportsStepInTargetsRequest = true

        response.body.supportsExceptionFilterOptions = false

        // make VS Code send exceptionInfo request
        response.body.supportsExceptionInfoRequest = false

        // make VS Code send setVariable request
        response.body.supportsSetVariable = true

        // make VS Code send setExpression request
        response.body.supportsSetExpression = true

        // make VS Code send disassemble request
        response.body.supportsDisassembleRequest = false
        response.body.supportsSteppingGranularity = true
        response.body.supportsInstructionBreakpoints = false

        // make VS Code able to read and write variable memory
        response.body.supportsReadMemoryRequest = true
        response.body.supportsWriteMemoryRequest = true

        response.body.supportSuspendDebuggee = false
        response.body.supportTerminateDebuggee = true
        response.body.supportsRestartRequest = true // graphics API cannot be 'restarted'. TODO would be restarting the application useful?
        response.body.supportsRestartFrame = false
        response.body.supportsFunctionBreakpoints = true
        response.body.supportsDelayedStackTraceLoading = true
        response.body.supportsSingleThreadExecutionRequests = false

        response.body.supportsConditionalBreakpoints = true
        response.body.supportsGotoTargetsRequest = false
        response.body.supportsHitConditionalBreakpoints = true
        response.body.supportsLogPoints = true

        this.sendResponse(response)

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent())
    }

    private processPushedBreakpoints(breakpoints: Breakpoint[]) {
        this.outputChannel?.appendLine("Processing pushed breakpoints")
        for (const bp of breakpoints) {
            this.sendEvent(new BreakpointEvent('new', this.convertDebuggerBreakpointToClient(bp)))
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
        try {
            await this.connected

            console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`)
            super.disconnectRequest(response, args)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments | undefined) {
        try {
            await this.connected

            await this._comm.terminate({ ...args, seq: response.request_seq })
            if (typeof deshader != 'undefined') {
                if (await isRunning()) {
                    terminate()
                }
            } else if (child_process && this._target) {
                this._target.kill()
            }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async initialState(response: DebugProtocol.Response) {
        const state = await this._comm.state({ seq: response.request_seq })
        this.singlePauseMode = state.singlePauseMode
        this.processPushedBreakpoints(state.breakpoints)
        if (state.paused) {
            this.sendEvent(new StoppedEvent('entry'))
        }
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
        try {
            if (this instanceof LoggingDebugSession) {
                // make sure to 'Stop' the buffered logging if 'trace' is not set
                logger.setup(args.showDebugOutput ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false)
            }

            await this.connectionConsistency(args)
            await this._comm.ensureConnected()
            const breakpointsFromSource = await this._comm!.debug({ ...args, seq: response.request_seq })
            response.body ||= {}

            this.sendResponse(response)

            await this.initialState(response)
            this._connected.resolve()
            setTimeout(() => this.processPushedBreakpoints(breakpointsFromSource), 500)
        } catch (e) {
            this.commError(response, e, "Failed to attach: ")
            this._connected.reject(e)
        }
    }

    private commError(response: DebugProtocol.Response, e?: any, message?: string) {
        this.sendErrorResponse(response, {
            id: 4,
            format: `${message || ""}${unknownToString(e, true)} while ${response.command}`,
            sendTelemetry: true,
        })
    }

    private async connectionConsistency(args: AttachArguments) {
        if (!args.connection) {
            args.connection = DebugSession.DEFAULT_CONNECTION
        }
        const parsed = new URL(args.connection)
        if (this._comm.endpointURL) {
            if (parsed.toString() != this._comm.endpointURL.toString()) {
                const choice = await vscode.window.showInformationMessage(`The connection URL ${args.connection} does not match already opened connection ${this._comm.endpointURL}`, {
                    modal: true,
                }, "Use current connection", "Use new connection")
                if (choice == "Use new connection") {
                    this._comm.endpointURL = parsed
                }
            }
        } else {
            this._comm.endpointURL = parsed
        }
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
        if (this instanceof LoggingDebugSession) {
            // make sure to 'Stop' the buffered logging if 'trace' is not set
            logger.setup(args.showDebugOutput ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false)
        }
        const config = vscode.workspace.getConfiguration('deshader')

        if (!args.connection) {
            args.connection = DebugSession.DEFAULT_CONNECTION
        }
        if (!args.env) {
            args.env = {}
        }
        args.env['DESHADER_CONNECTION'] ||= args.connection
        args.env['DESHADER_PROCESS'] ||= basename(args.program) // Whitelist the process to interception
        args.env['DESHADER_GUI'] ||= 'false' // Do not show another VSCode Editor

        //
        // Start the process
        //
        const argv = args.args ? [args.program, ...args.args] : [args.program]
        if (typeof deshader !== 'undefined') {
            // We are in Deshader Editor context
            try {
                await run(argv, args.cwd, args.env)
                if (!await isRunning()) {
                    this.sendErrorResponse(response, {
                        id: 2,
                        format: "Target exited immediately",
                        showUser: true,
                        sendTelemetry: false,
                    })
                    this._connected.reject()
                    return
                }
            } catch (e) {
                this.sendErrorResponse(response, {
                    id: 3,
                    format: "Failed to launch by RPC: " + unknownToString(e),
                    showUser: true,
                    sendTelemetry: true,
                })
                this._connected.reject()
                return
            }
            const checkInterval = config.get<number>('targetAliveCheck', 1000)
            const _this = this
            function check() {
                isRunning().then(r => {
                    if (r) setTimeout(check, checkInterval)
                    else _this.sendEvent(new TerminatedEvent())
                }).catch(() => _this.sendEvent(new TerminatedEvent()))
            }
            setTimeout(check, checkInterval)
        } else if (child_process) {
            // in Node.js context
            const launcher = config.get<string>('launcher', DebugSession.DEFAULT_LAUNCHER_PATH) || DebugSession.DEFAULT_LAUNCHER_PATH
            const deshader = config.get<string>('path', DebugSession.DEFAULT_LIBRARY_PATH) || DebugSession.DEFAULT_LIBRARY_PATH

            if (args.console == 'integratedTerminal') {
                const terminal = vscode.window.createTerminal({
                    name: "Deshader: " + basename(args.program),
                    cwd: args.cwd,
                    env: args.env,
                })
                const line = argv.join(' ')
                const changeListener = vscode.window.onDidChangeTerminalShellIntegration(async ({ terminal, shellIntegration }) => {
                    if (terminal === terminal) {
                        const execution = shellIntegration.executeCommand(line)
                        const endListener = vscode.window.onDidEndTerminalShellExecution(event => {
                            if (event.execution === execution) {
                                this.outputChannel?.appendLine(`Command exited with code ${event.exitCode}`)
                                endListener.dispose()
                            }
                        })
                        changeListener.dispose()
                    }
                })
                // Fallback to sendText if there is no shell integration within 3 seconds of launching
                setTimeout(() => {
                    if (!terminal.shellIntegration) {
                        terminal.sendText(line)
                        // Without shell integration, we can't know when the command has finished or what the
                        // exit code was.
                    }
                }, 3000)

                terminal.show()

            } else {
                const emulatorCommand = args.consoleHost ?? config.get<string>('defaultConsoleHost', 'xterm')
                const [emulator, ...emulatorArgs] = emulatorCommand.split(' ')
                const ext = args.console == 'externalTerminal'

                // try launcher
                try {
                    this._target = child_process.spawn(ext ? emulator : launcher, ext ? [...emulatorArgs, launcher, ...argv] : argv, {
                        cwd: args.cwd,
                        env: { ...process.env, ...args.env },
                        signal: this.abortTarget.signal,
                    })
                } catch (e) {
                    this.outputChannel?.appendLine("Failed to launch by launcher: " + unknownToString(e))
                }

                // try deshader
                try {
                    let insert: string | undefined = undefined
                    if (DebugSession._INSERT_LIBRARY_ENV) {
                        insert = process.env[DebugSession._INSERT_LIBRARY_ENV]
                        if (insert) {
                            insert += isWindows ? (";" + dirname(deshader)) : (":" + deshader)
                        } else {
                            insert = isWindows ? dirname(deshader) : deshader// On Windows PATH is set to the directory containing the deshader library to load dependent DLLs correctly
                        }
                    } else {
                        // On Windows
                        fs.symlinkSync(deshader, join(args.cwd ?? '', DebugSession._REPLACED_DLL), 'file')
                    }
                    this._target = child_process.spawn(ext ? emulator : args.program, ext ? [...emulatorArgs, ...(args.args || [])] : args.args, {
                        cwd: args.cwd,
                        env: {
                            ...process.env,
                            DESHADER_PROCESS: basename(args.program),
                            [DebugSession._INSERT_LIBRARY_ENV]: insert,
                            ...args.env,
                        },
                        signal: this.abortTarget.signal,
                    })
                } catch (e) {
                    this.outputChannel?.appendLine("Failed to launch by launcher: " + unknownToString(e))
                }
                if (!this._target) {
                    this._connected.reject()
                    return
                }
                // Setup events on the target
                this._target.on('error', (e) => {
                    this.outputChannel?.appendLine("Failed to launch: " + unknownToString(e))
                })
                this._target.on('exit', (code, signal) => {
                    this.outputChannel?.appendLine(`Target exited with code ${code} and signal ${signal}`)
                    this.sendEvent(new TerminatedEvent())
                })
                this._target.on('close', (code, signal) => {
                    this.outputChannel?.appendLine(`Target closed with code ${code} and signal ${signal}`)
                    this.sendEvent(new TerminatedEvent())
                })
                this._target.on('disconnect', () => {
                    this.outputChannel?.appendLine(`Target disconnected`)
                    this.sendEvent(new TerminatedEvent())
                })
                this._target.on('message', (message, _) => {
                    this.outputChannel?.appendLine(`Target message: ${message}`)
                })
                if (!ext) {
                    this._target.stdout?.on('data', (chunk) => {
                        if (debugSessions.size == 0) {
                            vscode.debug.activeDebugConsole.append(chunk.toString())
                        }
                        else {
                            this.sendEvent(new OutputEvent(chunk.toString(), 'stdout'))
                        }
                    })
                    this._target.stderr?.on('data', (chunk) => {
                        this.sendEvent(new OutputEvent(chunk.toString(), 'stderr'))
                    })
                }
            }
        } else {
            this.sendErrorResponse(response, {
                id: 1,
                format: "Cannot launch in this environment",
                showUser: true,
                sendTelemetry: true,
            })
            this._connected.reject()
            return
        }

        try {
            //
            // Connect to Deshader commands server
            //
            await this.connectionConsistency(args)
            await this._comm.ensureConnected()
            response.body ||= {}

            this.sendResponse(response)
            this._connected.resolve()
            //setTimeout(()=>this.processPushedBreakpoints(breakpointsFromSource), 500)
            await this.initialState(response)
        } catch (e) {
            this.commError(response, e, "Failed to launch: ")
            this._connected.reject(e)
        }
    }

    convertDebuggerBreakpointToClient<T extends Breakpoint | DebugProtocol.BreakpointLocation>(bp: T): typeof bp {
        let result: any = { verified: 'verified' in bp ? bp.verified : undefined }
        if (bp.line) { result.line = this.convertDebuggerLineToClient(bp.line) }
        if (bp.column) { result.column = this.convertDebuggerColumnToClient(bp.column) }
        if (bp.endColumn) { result.endColumn = this.convertDebuggerColumnToClient(bp.endColumn) }
        if (bp.endLine) { result.endLine = this.convertDebuggerLineToClient(bp.endLine) }
        if ('path' in bp && bp.path) { result.source = this.pathToSource(bp.path) }
        return result
    }

    protected convertClientBreakpointToDebugger(bp: DebugProtocol.SourceBreakpoint): DebugProtocol.SourceBreakpoint {
        return {
            line: this.convertClientLineToDebugger(bp.line),
            column: typeof bp.column !== 'undefined' ? this.convertClientColumnToDebugger(bp.column) : undefined,
            condition: bp.condition,
            hitCondition: bp.hitCondition,
            logMessage: bp.logMessage
        }
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<void> {
        try {
            await this.connected
            response.body = { breakpoints: [] }
            for (const bp of args.breakpoints) {
                response.body.breakpoints.push(this.convertDebuggerBreakpointToClient(await this._comm.setFunctionBreakpoint({ ...bp, seq: response.request_seq })))
            }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        try {
            await this.connected

            const path = this.sourceToPath(args.source)
            const breakpoints = await this._comm.setBreakpoints({ path, breakpoints: args.breakpoints?.map(bp => this.convertClientBreakpointToDebugger(bp)), seq: response.request_seq })

            // send back the actual breakpoint positions
            response.body = {
                breakpoints: breakpoints.map(bp => this.convertDebuggerBreakpointToClient(bp))
            }

            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments): Promise<void> {
        try {
            await this.connected

            args.line = this.convertClientLineToDebugger(args.line)
            if (args.endLine) { args.endLine = this.convertClientLineToDebugger(args.endLine) }
            if (args.column) { args.column = this.convertClientColumnToDebugger(args.column) }
            if (args.endColumn) { args.column = this.convertClientColumnToDebugger(args.endColumn) }

            const newArgs = {
                path: this.sourceToPath(args.source),
                ...args,
                seq: response.request_seq
            }
            delete (<any>newArgs).source
            const bps = await this._comm.possibleBreakpoints(newArgs)
            response.body = {
                breakpoints: bps.map(bp => this.convertDebuggerBreakpointToClient(bp))
            }

            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        try {
            await this.connected
            const stk = await this._comm?.stackTrace({ ...args, seq: response.request_seq })

            response.body = {
                stackFrames: stk.stackFrames.map(f => {
                    const sf: DebugProtocol.StackFrame = new StackFrame(f.id, f.name, this.pathToSource(f.path), this.convertDebuggerLineToClient(f.line))
                    if (typeof f.column === 'number') {
                        sf.column = this.convertDebuggerColumnToClient(f.column)
                    }
                    if (typeof f.endLine === 'number') {
                        sf.endLine = this.convertDebuggerLineToClient(f.endLine)
                    }
                    if (typeof f.endColumn === 'number') {
                        sf.endColumn = this.convertDebuggerColumnToClient(f.endColumn)
                    }

                    return sf
                }),
                // 4 options for 'totalFrames':
                //omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
                totalFrames: stk.totalFrames			// stk.totalFrames is the correct size, should result in a max. of two requests
                //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
                //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
            }

            this.currentShader = args.threadId
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
        try {
            await this.connected

            response.body = { scopes: await this._comm.scopes({ ...args, seq: response.request_seq }) }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            await this.connected

            const threads = await this._comm.runningShaders(response.request_seq)
            this.shaders = threads
            const resultThreads = this.convertThreads(threads)
            response.body = { threads: resultThreads }

            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    private convertThreads(shaders: RunningShader[]): DebugProtocol.Thread[] {
        const resultThreads: DebugProtocol.Thread[] = []
        for (const shader of shaders) {
            let dimensions = ""
            let selectedThread = ""
            if (shader.groupCount && shader.selectedGroup) {
                dimensions = shader.groupCount[0].toString()
                for (let i = 1; i < shader.groupCount.length; i++) {
                    dimensions += `,${shader.groupCount[i]}`
                    selectedThread += `,${shader.selectedGroup[i]}`
                }
                dimensions += "><"
                selectedThread += ")("
            }
            dimensions += shader.groupDim[0].toString()
            selectedThread += shader.selectedThread[0].toString()
            for (let i = 1; i < shader.groupDim.length; i++) {
                dimensions += `,${shader.groupDim[i]}`
                selectedThread += `,${shader.selectedThread[i]}`
            }

            resultThreads.push({
                id: shader.id,
                name: `${shader.name}<${dimensions}>(${selectedThread})`,
            })
        }
        return resultThreads
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments) {
        try {
            await this.connected

            response.body = await this._comm.writeMemory({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments) {
        try {
            await this.connected

            response.body = await this._comm.readMemory({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        try {
            await this.connected

            response.body = { variables: await this._comm.variables({ ...args, seq: response.request_seq }) }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        try {
            await this.connected

            const resp = await this._comm.setVariable({ ...args, seq: response.request_seq })
            response.body = resp
            if (resp.memoryReference) {
                this.sendEvent(new MemoryEvent(String(resp.memoryReference), 0, resp.length!))
            }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
        try {
            await this.connected

            await this._comm.continue({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
        try {
            await this.connected

            await this._comm.next({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
        try {
            await this.connected

            const targets = await this._comm.getStepInTargets({ ...args, seq: response.request_seq })
            response.body = {
                targets: targets.map(t => {
                    if (t.column) { t.column = this.convertDebuggerColumnToClient(t.column) }
                    if (t.endColumn) { t.endColumn = this.convertDebuggerColumnToClient(t.endColumn) }
                    if (t.endLine) { t.endLine = this.convertDebuggerLineToClient(t.endLine) }
                    if (t.line) { t.line = this.convertDebuggerLineToClient(t.line) }
                    return t
                })
            }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        try {
            await this.connected

            await this._comm.stepIn({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        try {
            await this.connected

            await this._comm.stepOut({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        try {
            await this.connected

            if (args.context == 'repl' && args.expression[0] == '/') {// send a manual command from debug console
                this.sendEvent(new OutputEvent(await this._comm.send(args.expression.substring(1)), 'console'))
            }
            else {
                response.body = await this._comm.evaluate({ ...args, seq: response.request_seq })
            }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): Promise<void> {
        try {
            await this.connected

            response.body = await this._comm.setExpression({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): Promise<void> {
        try {
            await this.connected

            response.body = await this._comm.dataBreakpointInfo({ ...args, seq: response.request_seq })
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): Promise<void> {
        try {
            await this.connected

            // clear all data breakpoints
            this._comm.clearDataBreakpoints(response.request_seq)

            response.body = {
                breakpoints: []
            }

            for (const dbp of args.breakpoints) {
                const bp = await this._comm.setDataBreakpoint({ ...dbp, seq: response.request_seq })
                response.body.breakpoints.push(bp)
            }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): Promise<void> {
        try {
            await this.connected

            response.body = { targets: await this._comm.completion({ ...args, seq: response.request_seq }) }
            this.sendResponse(response)
        } catch (e) {
            this.commError(response, e)
        }
    }

    protected async customRequest(command: string, response: DebugProtocol.Response, args: any) {
        switch (command) {
            case 'toggleFormatting':
                this._valuesInHex = !this._valuesInHex
                if (this._useInvalidatedEvent) {
                    this.sendEvent(new InvalidatedEvent(['variables']))
                }
                break
            case 'getCurrentShader':
                response.body = this.shaders[this.currentShader]
                break
            case 'getPauseMode':
                response.body = this.singlePauseMode
                break
            case 'updateStackItem':
                const item = <vscode.DebugStackFrame | vscode.DebugThread>args
                this.currentShader = item.threadId
                break
            case 'selectThread':
                await this._comm.selectThread({ shader: this.currentShader, thread: args.thread, group: args.group, seq: response.request_seq })
                break
            case 'pauseMode':
                await this._comm.pauseMode({ seq: response.request_seq, single: args.single })// TODO detect errors
                this.singlePauseMode = args.single
                break
            default: this.sendErrorResponse(response, 1014, 'unrecognized request', null, ErrorDestination.Telemetry)
        }

        this.sendResponse(response)
    }

    // debugger paths do not include deshader: scheme
    private pathToSource(path: string): Source {
        return new Source(basename(path),
            // path contains leading slash
            `deshader:${path}`,
        )
    }

    // debugger paths do not include deshader: scheme
    private sourceToPath(source: DebugProtocol.Source): string {
        if (source.path) {
            const parsed = vscode.Uri.parse(source.path)// assumes one leading slash after protocol
            return parsed.path
        } else {
            return `/untagged/${source.sourceReference!}`
        }
    }
}