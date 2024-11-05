import { DebugProtocol } from '@vscode/debugprotocol';
import {
    logger,
    LoggingDebugSession,
    Event,
    StoppedEvent, InitializedEvent, TerminatedEvent, BreakpointEvent, OutputEvent,
    ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
    Thread, StackFrame, Scope, Source, MemoryEvent, Logger, ErrorDestination
} from '@vscode/debugadapter';
import { Communicator, Config, Events, EventArgs, RunningShader, LaunchArguments, AttachArguments, Breakpoint, BreakpointEvent as DeshaderBreakpointEvent } from '../deshader';
import { Subject } from 'await-notify';
import * as vscode from 'vscode';
import { DebugSessionBase } from 'conditional-debug-session';
import { basename } from 'path-browserify';

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments, LaunchArguments { }

interface IAttachRequestArguments extends DebugProtocol.LaunchRequestArguments, AttachArguments { }

export class DebugSession extends DebugSessionBase {
    static connectionNotOpen = "Connection not open";
    public shaders: RunningShader[] = [];
    // index into this.shaders
    public currentShader = 0;
    public outputChannel: vscode.OutputChannel | null = null;
    public singlePauseMode = false;

    private _comm: Communicator | null;
    private _ownsComm = true;

    private _configurationDone = new Subject();

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
    public constructor(comm: Communicator | null, outputChannel: vscode.OutputChannel | null = null) {
        super();
        this.outputChannel = outputChannel;
        this._comm = comm;
        if (comm != null) {
            this._ownsComm = false;
        }

        // this debugger uses zero-based lines and columns
        if (this instanceof LoggingDebugSession) {
            this.setDebuggerLinesStartAt1(false);
            this.setDebuggerColumnsStartAt1(false);

        }
        this.setupEvents();
        this.setDebuggerPathFormat('deshader'); // Everything other that 'path' is considered as an URI
    }

    dispose() {
        if (this._ownsComm) {
            this._comm?.output.dispose();
            this._comm?.disconnect();
        }
        super.dispose();
    }

    setupEvents() {
        if (this._comm === null) {
            throw new Error("Communicator not set up");
        }
        // setup event handlers
        this._comm.onJson<'stop'>(Events.stop, params => {
            if (params.step == 0) {
                this.sendEvent(new StoppedEvent('entry', params.shader));
            } else
                {this.sendEvent(new StoppedEvent('step', params.shader));}
        });
        this._comm.onJson<'stopOnBreakpoint'>(Events.stopOnBreakpoint, (params) => {
            this.sendEvent(new Event('stopped', <DebugProtocol.StoppedEvent['body']>({ reason: 'breakpoint', threadId: params.shader, hitBreakpointIds: params.ids })));
        });
        this._comm.onJson<'stopOnDataBreakpoint'>(Events.stopOnDataBreakpoint, (threadID) => {
            this.sendEvent(new StoppedEvent('data breakpoint', threadID));
        });
        this._comm.onJson<'breakpoint'>(Events.breakpoint, (event: DeshaderBreakpointEvent) => {
            this.sendEvent(new BreakpointEvent(event.reason, this.convertDebuggerBreakpointToClient(event.breakpoint)));
        });
        this._comm.onJson<'invalidated'>(Events.invalidated, (event) => {
            if (this._useInvalidatedEvent) {
                this.sendEvent(new InvalidatedEvent(event.areas, event.threadId, event.stackFrameId));
            }
        });
        this._comm.onJson<'output'>(Events.output, (args: EventArgs['output']) => {
            const [type, text, source, line, column] = args;

            let category: string;
            switch (type) {
                case 'prio': category = 'important'; break;
                case 'out': category = 'stdout'; break;
                case 'err': category = 'stderr'; break;
                default: category = 'console'; break;
            }
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category);

            if (text === 'start' || text === 'startCollapsed' || text === 'end') {
                e.body.group = text;
                e.body.output = `group-${text}\n`;
            }

            e.body.source = this.pathToSource(source);
            e.body.line = this.convertDebuggerLineToClient(line);
            e.body.column = this.convertDebuggerColumnToClient(column);
            this.sendEvent(e);
        });
        this._comm.on<'end'>(Events.end, () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {
        this.outputChannel?.appendLine(`sendRequest ${command} ${JSON.stringify(args)}`);
        super.sendRequest(command, args, timeout, cb);
    }

    public sendEvent(event: DebugProtocol.Event): void {
        this.outputChannel?.appendLine(`sendEvent ${event.event} ${JSON.stringify(event.body)}`);
        super.sendEvent(event);
    }

    public sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string | undefined, variables?: any, dest?: ErrorDestination | undefined): void {
        this.outputChannel?.appendLine(`sendErrorResponse ${response.command} ${codeOrMessage}`);
        super.sendErrorResponse(response, codeOrMessage, format, variables, dest);
    }

    public sendResponse(response: DebugProtocol.Response): void {
        this.outputChannel?.appendLine(`sendResponse ${response.command} ${JSON.stringify(response.body)}`);
        super.sendResponse(response);
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): Promise<void> {

        if (args.supportsProgressReporting) {
            this._reportProgress = true;
        }
        if (args.supportsInvalidatedEvent) {
            this._useInvalidatedEvent = true;
        }

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDone request.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code show a 'step back' button
        response.body.supportsStepBack = false;

        // make VS Code support data breakpoints
        response.body.supportsDataBreakpoints = true;

        // make VS Code support completion in REPL
        response.body.supportsCompletionsRequest = true;
        response.body.completionTriggerCharacters = ["."];

        // make VS Code send cancel request
        response.body.supportsCancelRequest = false;

        // make VS Code send the breakpointLocations request
        response.body.supportsBreakpointLocationsRequest = true;

        // make VS Code provide "Step in Target" (selecting stack frame) functionality
        response.body.supportsStepInTargetsRequest = true;

        response.body.supportsExceptionFilterOptions = false;

        // make VS Code send exceptionInfo request
        response.body.supportsExceptionInfoRequest = false;

        // make VS Code send setVariable request
        response.body.supportsSetVariable = true;

        // make VS Code send setExpression request
        response.body.supportsSetExpression = true;

        // make VS Code send disassemble request
        response.body.supportsDisassembleRequest = false;
        response.body.supportsSteppingGranularity = true;
        response.body.supportsInstructionBreakpoints = false;

        // make VS Code able to read and write variable memory
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsWriteMemoryRequest = true;

        response.body.supportSuspendDebuggee = false;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsRestartRequest = true; // graphics API cannot be 'restarted'. TODO would be restarting the application useful?
        response.body.supportsRestartFrame = false;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsDelayedStackTraceLoading = true;
        response.body.supportsSingleThreadExecutionRequests = false;

        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;
        if (this._comm === null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        }

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
        if (this._comm) {
            const state = await this._comm.state({ seq: response.request_seq });
            this.singlePauseMode = state.singlePauseMode;
            this.processPushedBreakpoints(state.breakpoints);
            if (state.paused) {
                this.sendEvent(new StoppedEvent('entry'));
            }
        }
    }

    private processPushedBreakpoints(breakpoints: Breakpoint[]) {
        this.outputChannel?.appendLine("Processing pushed breakpoints");
        for (const bp of breakpoints) {
            this.sendEvent(new BreakpointEvent('new', this.convertDebuggerBreakpointToClient(bp)));
        }
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
        if (this._ownsComm) {
            this._comm?.output.dispose();
            this._comm?.disconnect();
        }
        this.sendResponse(response);
    }

    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments | undefined): void {
        if (this._comm === null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            this._comm.terminate({ ...args, seq: response.request_seq });
        }
        this.sendResponse(response);
    }

    async connectOwnedComm(config: Config) {
        this._comm = Communicator.fromConfig(config, vscode.window.createOutputChannel("Deshader Debugger"), false);
        await this._comm.connected;
        this._ownsComm = true;
        this.setupEvents();
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
        if (this._comm == null) {
            await this.connectOwnedComm(args.connection);
        } else {
            await this._comm.ensureConnected();
        }
        await this._configurationDone.wait(1000);
        const breakpointsFromSource = await this._comm!.debug({ ...args, seq: response.request_seq });
        response.body ||= {};

        this.sendResponse(response);
        setTimeout(() => this.processPushedBreakpoints(breakpointsFromSource), 500);
        this.sendRequest("runInTerminal", <DebugProtocol.RunInTerminalRequestArguments>{
            title: "Test",
            args: ["help"],
            kind: "integrated",
            cwd: "${workspaceFolder}",
            argsCanBeInterpretedByShell: true,
        }, 1000, (response) => {
            console.log("RIT response", response);
        });
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
        if (this instanceof LoggingDebugSession) {
            // make sure to 'Stop' the buffered logging if 'trace' is not set
            logger.setup(args.showDebugOutput ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
        }

        if (this._comm == null) {
            await this.connectOwnedComm(args.connection || {
                host: "localhost",
                port: 8082,
                protocol: "ws"
            });
        } else {
            await this._comm.ensureConnected();
        }

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);
        response.body ||= {};

        // start the program in the runtime
        //await this._comm.start(args.program, !!args.stopOnEntry, !args.noDebug);

        this.sendResponse(response);
        //setTimeout(()=>this.processPushedBreakpoints(breakpointsFromSource), 500)
    }

    convertDebuggerBreakpointToClient<T extends Breakpoint | DebugProtocol.BreakpointLocation>(bp: T): typeof bp {
        let result: any = { verified: 'verified' in bp ? bp.verified : undefined };
        if (bp.line)
            {result.line = this.convertDebuggerLineToClient(bp.line);}
        if (bp.column)
            {result.column = this.convertDebuggerColumnToClient(bp.column);}
        if (bp.endColumn)
            {result.endColumn = this.convertDebuggerColumnToClient(bp.endColumn);}
        if (bp.endLine)
            {result.endLine = this.convertDebuggerLineToClient(bp.endLine);}
        if ('path' in bp && bp.path)
            {result.source = this.pathToSource(bp.path);}
        return result;
    }

    protected convertClientBreakpointToDebugger(bp: DebugProtocol.SourceBreakpoint): DebugProtocol.SourceBreakpoint {
        return {
            line: this.convertClientLineToDebugger(bp.line),
            column: typeof bp.column !== 'undefined' ? this.convertClientColumnToDebugger(bp.column) : undefined,
            condition: bp.condition,
            hitCondition: bp.hitCondition,
            logMessage: bp.logMessage
        };
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<void> {
        if (this._comm === null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = { breakpoints: [] };
            for (const bp of args.breakpoints) {
                response.body.breakpoints.push(this.convertDebuggerBreakpointToClient(await this._comm.setFunctionBreakpoint({ ...bp, seq: response.request_seq })));
            }
        }
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const path = this.sourceToPath(args.source);

            const breakpoints = await this._comm.setBreakpoints({ path, breakpoints: args.breakpoints?.map(bp => this.convertClientBreakpointToDebugger(bp)), seq: response.request_seq });

            // send back the actual breakpoint positions
            response.body = {
                breakpoints: breakpoints.map(bp => this.convertDebuggerBreakpointToClient(bp))
            };
        }
        this.sendResponse(response);

    }

    protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {

            args.line = this.convertClientLineToDebugger(args.line);
            if (args.endLine)
                {args.endLine = this.convertClientLineToDebugger(args.endLine);}
            if (args.column)
                {args.column = this.convertClientColumnToDebugger(args.column);}
            if (args.endColumn)
                {args.column = this.convertClientColumnToDebugger(args.endColumn);}

            const newArgs = {
                path: this.sourceToPath(args.source),
                ...args,
                seq: response.request_seq
            };
            delete (<any>newArgs).source;
            const bps = await this._comm.possibleBreakpoints(newArgs);
            response.body = {
                breakpoints: bps.map(bp => this.convertDebuggerBreakpointToClient(bp))
            };
        }
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        }
        else {
            const stk = await this._comm?.stackTrace({ ...args, seq: response.request_seq });

            response.body = {
                stackFrames: stk.stackFrames.map(f => {
                    const sf: DebugProtocol.StackFrame = new StackFrame(f.id, f.name, this.pathToSource(f.path), this.convertDebuggerLineToClient(f.line));
                    if (typeof f.column === 'number') {
                        sf.column = this.convertDebuggerColumnToClient(f.column);
                    }
                    if (typeof f.endLine === 'number') {
                        sf.endLine = this.convertDebuggerLineToClient(f.endLine);
                    }
                    if (typeof f.endColumn === 'number') {
                        sf.endColumn = this.convertDebuggerColumnToClient(f.endColumn);
                    }

                    return sf;
                }),
                // 4 options for 'totalFrames':
                //omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
                totalFrames: stk.totalFrames			// stk.totalFrames is the correct size, should result in a max. of two requests
                //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
                //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
            };
        }
        this.currentShader = args.threadId;
        this.sendResponse(response);
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = { scopes: await this._comm.scopes({ ...args, seq: response.request_seq }) };
        }
        this.sendResponse(response);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const threads = await this._comm.runningShaders(response.request_seq);
            this.shaders = threads;
            const resultThreads = this.convertThreads(threads);
            response.body = { threads: resultThreads };
        }
        this.sendResponse(response);
    }

    private convertThreads(shaders: RunningShader[]): DebugProtocol.Thread[] {
        const resultThreads: DebugProtocol.Thread[] = [];
        for (const shader of shaders) {
            let dimensions = "";
            let selectedThread = "";
            if (shader.groupCount && shader.selectedGroup) {
                dimensions = shader.groupCount[0].toString();
                for (let i = 1; i < shader.groupCount.length; i++) {
                    dimensions += `,${shader.groupCount[i]}`;
                    selectedThread += `,${shader.selectedGroup[i]}`;
                }
                dimensions += "><";
                selectedThread += ")(";
            }
            dimensions += shader.groupDim[0].toString();
            selectedThread += shader.selectedThread[0].toString();
            for (let i = 1; i < shader.groupDim.length; i++) {
                dimensions += `,${shader.groupDim[i]}`;
                selectedThread += `,${shader.selectedThread[i]}`;
            }

            resultThreads.push({
                id: shader.id,
                name: `${shader.name}<${dimensions}>(${selectedThread})`,
            });
        }
        return resultThreads;
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.writeMemory({ ...args, seq: response.request_seq });
        }

        this.sendResponse(response);
    }

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.readMemory({ ...args, seq: response.request_seq });
        }

        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = { variables: await this._comm.variables({ ...args, seq: response.request_seq }) };
        }
        this.sendResponse(response);
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const resp = await this._comm.setVariable({ ...args, seq: response.request_seq });
            response.body = resp;
            if (resp.memoryReference) {
                this.sendEvent(new MemoryEvent(String(resp.memoryReference), 0, resp.length!));
            }
        }
        this.sendResponse(response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            await this._comm.continue({ ...args, seq: response.request_seq });
        }
        this.sendResponse(response);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            await this._comm.next({ ...args, seq: response.request_seq });
        }
        this.sendResponse(response);
    }

    protected async stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const targets = await this._comm.getStepInTargets({ ...args, seq: response.request_seq });
            response.body = {
                targets: targets.map(t => {
                    if (t.column)
                        {t.column = this.convertDebuggerColumnToClient(t.column);}
                    if (t.endColumn)
                        {t.endColumn = this.convertDebuggerColumnToClient(t.endColumn);}
                    if (t.endLine)
                        {t.endLine = this.convertDebuggerLineToClient(t.endLine);}
                    if (t.line)
                        {t.line = this.convertDebuggerLineToClient(t.line);}
                    return t;
                })
            };
        }
        this.sendResponse(response);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            await this._comm.stepIn({ ...args, seq: response.request_seq });
        }
        this.sendResponse(response);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            await this._comm.stepOut({ ...args, seq: response.request_seq });
        }
        this.sendResponse(response);
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.evaluate({ ...args, seq: response.request_seq });
        }
        this.sendResponse(response);
    }

    protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.setExpression({ ...args, seq: response.request_seq });
        }

        this.sendResponse(response);
    }

    protected async dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.dataBreakpointInfo({ ...args, seq: response.request_seq });
        }

        this.sendResponse(response);
    }

    protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            // clear all data breakpoints
            this._comm.clearDataBreakpoints(response.request_seq);

            response.body = {
                breakpoints: []
            };

            for (const dbp of args.breakpoints) {
                const bp = await this._comm.setDataBreakpoint({ ...dbp, seq: response.request_seq });
                response.body.breakpoints.push(bp);
            }
        }
        this.sendResponse(response);
    }

    protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = { targets: await this._comm.completion({ ...args, seq: response.request_seq }) };
        }
        this.sendResponse(response);
    }

    protected async customRequest(command: string, response: DebugProtocol.Response, args: any) {
        switch (command) {
            case 'toggleFormatting':
                this._valuesInHex = !this._valuesInHex;
                if (this._useInvalidatedEvent) {
                    this.sendEvent(new InvalidatedEvent(['variables']));
                }
                break;
            case 'getCurrentShader':
                response.body = this.shaders[this.currentShader];
                break;
            case 'getPauseMode':
                response.body = this.singlePauseMode;
                break;
            case 'updateStackItem':
                const item = <vscode.DebugStackFrame | vscode.DebugThread>args;
                this.currentShader = item.threadId;
                break;
            case 'selectThread':
                if (this._comm == null) {
                    response.success = false;
                    response.message = DebugSession.connectionNotOpen;
                } else {
                    await this._comm.selectThread({ shader: this.currentShader, thread: args.thread, group: args.group, seq: response.request_seq });
                }
                break;
            case 'pauseMode':
                if (this._comm == null) {
                    response.success = false;
                    response.message = DebugSession.connectionNotOpen;
                } else {
                    await this._comm.pauseMode({ seq: response.request_seq, single: args.single });// TODO detect errors
                    this.singlePauseMode = args.single;
                }
                break;
            default: this.sendErrorResponse(response, 1014, 'unrecognized request', null, ErrorDestination.Telemetry);
        }

        this.sendResponse(response);
    }

    // debugger paths do not include deshader: scheme
    private pathToSource(path: string): Source {
        return new Source(basename(path),
            // path contains leading slash
            `deshader:${path}`,
        );
    }

    // debugger paths do not include deshader: scheme
    private sourceToPath(source: DebugProtocol.Source): string {
        if (source.path) {
            const parsed = vscode.Uri.parse(source.path);// assumes one leading slash after protocol
            return parsed.path;
        } else {
            return `/untagged/${source.sourceReference!}`;
        }
    }
}