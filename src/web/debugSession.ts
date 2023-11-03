import { DebugProtocol } from 'vscode-debugprotocol';
import { LoggingDebugSession, DebugSession as DebugSessionBase } from 'vscode-debugadapter';

const Base = process.browser ? DebugSessionBase : LoggingDebugSession;

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
    /** Optional arguments passed to the debuggee. */
    args?: string[];
    /** Optional working directory for the debuggee. */
    cwd?: string;
    /** Optional environment variables to pass to the debuggee. The string valued properties of the 'environmentVariables' are used as key/value pairs. */
    env?: { [key: string]: string };
    /** Console used to read/write debuggee stdin/stdout. Defaults to "internalConsole". */
    console?: 'debugConsole' | 'integratedTerminal' | 'externalTerminal';
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** Show debug output from the debug adapted */
    showDevDebugOutput?: boolean;
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    /** IP address of the debug  */
    address: string;
    /** Port of the debug  */
    port: number;
    /** Communication protocol */
    protocol: 'http' | 'https';
    /** Console */
    console?: 'debugConsole' | 'integratedTerminal' | 'externalTerminal';
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** Show debug output from the debug adapted */
    showDevDebugOutput?: boolean;
}

export class DebugSession extends Base {

};