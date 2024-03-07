import { DebugProtocol } from '@vscode/debugprotocol';
import {
    logger,
    LoggingDebugSession,
    StoppedEvent, InitializedEvent, TerminatedEvent, BreakpointEvent, OutputEvent,
    ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
    Thread, StackFrame, Scope, Source, Breakpoint, MemoryEvent, Logger
} from '@vscode/debugadapter';
import { Communicator, Config, Events } from './deshader';
import { Subject } from 'await-notify';
import * as vscode from 'vscode'
import { DebugSessionBase } from 'conditional-debug-session'
import assert = require('assert');
import { basename } from 'path';

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    showDebugOutput?: boolean;
    args: string[];
    cwd?: string;
    env?: { [key: string]: string };
    console?: 'debugConsole' | 'integratedTerminal' | 'externalTerminal';
    connection?: Config;
    showDevDebugOutput?: boolean;
}

interface IAttachRequestArguments extends DebugProtocol.LaunchRequestArguments {
    connection: Config;
    showDebugOutput?: ILaunchRequestArguments['showDebugOutput'];
    stopOnEntry?: ILaunchRequestArguments['stopOnEntry'];
}

interface IEmbeddedRequestArguments extends DebugProtocol.LaunchRequestArguments {
    protocol: Config['protocol'];
    showDebugOutput?: ILaunchRequestArguments['showDebugOutput'];
    stopOnEntry?: ILaunchRequestArguments['stopOnEntry'];
}

export class DebugSession extends DebugSessionBase {
    static connectionNotOpen = "Connection not open";

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

    private _addressesInHex = true;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor(comm: Communicator | null) {
        super();
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
    }

    dispose() {
        if (this._ownsComm) {
            this._comm?.output.dispose();
            this._comm?.dispose();
        }
        super.dispose()
    }

    setupEvents() {
        assert(this._comm != null);
        // setup event handlers
        this._comm.on<'stopOnEntry'>(Events.stopOnEntry, (threadID) => {
            this.sendEvent(new StoppedEvent('entry', threadID));
        });
        this._comm.on<'stopOnStep'>(Events.stopOnStep, (threadID) => {
            this.sendEvent(new StoppedEvent('step', threadID));
        });
        this._comm.on<'stopOnBreakpoint'>(Events.stopOnBreakpoint, (threadID) => {
            this.sendEvent(new StoppedEvent('breakpoint', threadID));
        });
        this._comm.on<'stopOnDataBreakpoint'>(Events.stopOnDataBreakpoint, (threadID) => {
            this.sendEvent(new StoppedEvent('data breakpoint', threadID));
        });
        this._comm.on<'breakpointValidated'>(Events.breakpointValidated, (bp: DebugProtocol.Breakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', bp));
        });
        this._comm.on<'output'>(Events.output, (type, text, filePath, line, column) => {

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

            e.body.source = this.createSource(filePath);
            e.body.line = this.convertDebuggerLineToClient(line);
            e.body.column = this.convertDebuggerColumnToClient(column);
            this.sendEvent(e);
        });
        this._comm.on<'end'>(Events.end, () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

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
        response.body.supportsCancelRequest = true;

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
        response.body.supportsFunctionBreakpoints = false;
        response.body.supportsDelayedStackTraceLoading = true;

        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
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

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
        if (this._ownsComm) {
            this._comm?.output.dispose();
            this._comm?.dispose();
        }
    }

    async connectOwnedComm(config: Config) {
        this._comm = Communicator.fromConfig(config, vscode.window.createOutputChannel("Deshader Debugger"), false)
        await this._comm.connected;
        this._ownsComm = true;
        this.setupEvents();
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
        if (this._comm == null) {
            await this.connectOwnedComm(args.connection);
        }
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
        if (this instanceof LoggingDebugSession) {
            // make sure to 'Stop' the buffered logging if 'trace' is not set
            logger.setup(args.showDebugOutput ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
        }

        if (this._comm == null) {
            await this.connectOwnedComm(args.connection || {
                address: "localhost",
                port: 8082,
                protocol: "ws"
            });
        }

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        // start the program in the runtime
        //await this._comm.start(args.program, !!args.stopOnEntry, !args.noDebug);

        this.sendResponse(response);
    }

    convertDebuggerBreakpointToClient(bp: DebugProtocol.Breakpoint): DebugProtocol.Breakpoint {
        if (bp.line)
            bp.line = this.convertDebuggerLineToClient(bp.line);
        if (bp.column)
            bp.column = this.convertDebuggerColumnToClient(bp.column);
        if (bp.endColumn)
            bp.endColumn = this.convertDebuggerColumnToClient(bp.endColumn);
        if (bp.endLine)
            bp.endLine = this.convertDebuggerLineToClient(bp.endLine);
        return bp;
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this._comm === null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            for(const bp of args.breakpoints) {
                response.body.breakpoints.push(this.convertDebuggerBreakpointToClient(await this._comm.setFunctionBreakpoint(bp)));
            }
        }
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const path = args.source.path as string;

            // clear all breakpoints for this file
            this._comm.clearBreakpoints(path);

            // set and verify breakpoint locations
            const actualBreakpoints0 = (args.breakpoints || []).map(async l => {
                let bp = await this._comm!.setBreakpoint(path, this.convertClientLineToDebugger(l.line), 0);
                bp = this.convertDebuggerBreakpointToClient(bp)
                return bp;
            });
            const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

            // send back the actual breakpoint positions
            response.body = {
                breakpoints: actualBreakpoints
            };
        }
        this.sendResponse(response);
    }

    protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            if (args.source.path) {
                args.line = this.convertClientLineToDebugger(args.line);
                if (args.endLine)
                    args.endLine = this.convertClientLineToDebugger(args.endLine);
                if (args.column)
                    args.column = this.convertClientColumnToDebugger(args.column);
                if (args.endColumn)
                    args.column = this.convertClientColumnToDebugger(args.endColumn);

                const bps = await this._comm.getBreakpoints(args);
                response.body = {
                    breakpoints: bps.map(bp => {
                        bp.line = this.convertDebuggerLineToClient(bp.line);
                        if (bp.column)
                            bp.column = this.convertDebuggerColumnToClient(bp.column);
                        if (bp.endLine)
                            bp.endLine = this.convertDebuggerLineToClient(bp.endLine);
                        if (bp.endColumn)
                            bp.endColumn = this.convertDebuggerColumnToClient(bp.endColumn);
                        return bp;
                    })
                };
            } else {
                response.body = {
                    breakpoints: []
                };
            }
        }
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        }
        else {
            const stk = await this._comm?.stackTrace(args);

            response.body = {
                stackFrames: stk.map(f => {
                    const sf: DebugProtocol.StackFrame = new StackFrame(f.id, f.name, this.createSource(f.source!.path!), this.convertDebuggerLineToClient(f.line));
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
                totalFrames: stk.length			// stk.count is the correct size, should result in a max. of two requests
                //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
                //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
            };
        }
        this.sendResponse(response);
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body.scopes = await this._comm.scopes(args);
        }
        this.sendResponse(response);
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.writeMemory(args);
        }

        this.sendResponse(response);
    }

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.readMemory(args);
        }

        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body.variables = await this._comm.variables(args);
        }
        this.sendResponse(response);
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const resp = await this._comm.setVariable(args);
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
            await this._comm.continue();
        }
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const thread = args.singleThread !== false ? args.threadId : undefined;
            this._comm[args.granularity == 'statement' ? 'stepStatement' : 'stepLine'](thread);
        }
        this.sendResponse(response);
    }

    protected async stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            const targets = await this._comm.getStepInTargets(args.frameId);
            response.body = {
                targets: targets.map(t => {
                    if (t.column)
                        t.column = this.convertDebuggerColumnToClient(t.column);
                    if (t.endColumn)
                        t.endColumn = this.convertDebuggerColumnToClient(t.endColumn);
                    if (t.endLine)
                        t.endLine = this.convertDebuggerLineToClient(t.endLine);
                    if (t.line)
                        t.line = this.convertDebuggerLineToClient(t.line);
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
            await this._comm.stepIn(args);
        }
        this.sendResponse(response);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            await this._comm.stepOut(args);
        }
        this.sendResponse(response);
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.evaluate(args);
        }
        this.sendResponse(response);
    }

    protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.setExpression(args);
        }

        this.sendResponse(response);
    }

    protected async dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            response.body = await this._comm.dataBreakpointInfo(args)
        }

        this.sendResponse(response);
    }

    protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): Promise<void> {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            // clear all data breakpoints
            this._comm.clearAllDataBreakpoints();

            response.body = {
                breakpoints: []
            };

            for (const dbp of args.breakpoints) {
                const bp = await this._comm.setDataBreakpoint(dbp);
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
            response.body.targets = await this._comm.completion(args)
        }
        this.sendResponse(response);
    }

    protected async cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
        if (this._comm == null) {
            response.success = false;
            response.message = DebugSession.connectionNotOpen;
        } else {
            await this._comm.cancel(args);
            if (args.requestId) {
                this._cancellationTokens.set(args.requestId, true);
            }
            if (args.progressId) {
                this._cancelledProgressId = args.progressId;
            }
        }
        this.sendResponse(response);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
        if (command === 'toggleFormatting') {
            this._valuesInHex = !this._valuesInHex;
            if (this._useInvalidatedEvent) {
                this.sendEvent(new InvalidatedEvent(['variables']));
            }
            this.sendResponse(response);
        } else {
            super.customRequest(command, response, args);
        }
    }

    private createSource(filePath: string, id?: number): Source {
        return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), id);
    }
};