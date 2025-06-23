import * as vscode from 'vscode'
import Commands from './commands'
import { DebugSession } from './debug/session'
import { Communicator, RunningShader } from './deshader'

export function createStatusBarItems(context: vscode.ExtensionContext, comm: Communicator) {
    const thread = vscode.window.createStatusBarItem('selectedThread', vscode.StatusBarAlignment.Left, 900)
    context.subscriptions.push(thread)
    thread.name = 'Selected Pivot Thread'
    thread.command = Commands.selectThread

    const mode = vscode.window.createStatusBarItem('threadMode', vscode.StatusBarAlignment.Left, 850)
    context.subscriptions.push(mode)
    mode.command = Commands.threadMode
    mode.name = 'Multithreading Mode'

    // Priority 98 is after the default status bar items but before the feedback status item
    const saveMode = vscode.window.createStatusBarItem('saveMode', vscode.StatusBarAlignment.Right, 98)
    saveMode.name = "Save Mode"
    saveMode.command = Commands.saveMode

    vscode.window.onDidChangeActiveTextEditor(e => {
        if (e) {
            if(e.document.uri.authority.startsWith('deshader') || e.document.uri.scheme.startsWith('deshader')) {
                saveMode.show()
                return
            }
        }
        saveMode.hide()
    })

    function updateSaveMode(physical: boolean) {
        saveMode.text = physical ? '$(save-as)' : '$(save)'
        saveMode.tooltip = physical ? 'Save Mode: Physically' : 'Save Mode: Virtually'
    }

    async function updateStatus(session?: vscode.DebugSession) {
        connection.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground')
        if (typeof session !== 'undefined' && session.type == DebugSession.TYPE) {
            mode.show()
            thread.show()
        } else {
            mode.hide()
            thread.hide()
        }
    }
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(updateStatus),
        vscode.debug.onDidChangeActiveDebugSession(updateStatus),
        vscode.debug.onDidTerminateDebugSession((e) => {
            if (e.type == DebugSession.TYPE) {
                mode.hide()
                thread.hide()
            }
        }))
    const config = vscode.workspace.getConfiguration('deshader')
    let singleThreadMode = true
    updateThreadMode(config.get<string>('debugging.threadMode', 'single') == 'single')
    updateSaveMode(config.get<string>('saveMode') === 'physical')
    function updateThreadMode(single: boolean) {
        singleThreadMode = single
        mode.text = single ? '$(run)' : '$(run-all)'
        mode.tooltip = `Select multithreaded debugging mode (now ${single ? 'single' : 'all'})`
        thread.backgroundColor = single ? new vscode.ThemeColor('statusBarItem.prominentBackground') : undefined
        thread.color = single ? new vscode.ThemeColor('statusBarItem.prominentForeground') : undefined
    }

    // Update the current shader ref when the active debug session selected thread changes by a UI action
    if (typeof vscode.debug.onDidChangeActiveStackItem !== 'undefined') {
        context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(async (e) => {
            if (typeof e !== 'undefined' && e.session.type === DebugSession.TYPE) {
                // select the thread to return info about
                await e.session.customRequest('updateStackItem', e)
                // query the current shader
                const currentShader = await e.session.customRequest('getCurrentShader') as RunningShader
                if (!currentShader) {
                    thread.hide()
                    return
                }
                if (currentShader.pivot.group) {
                    thread.text = `$(pulse) (${currentShader.pivot.group.join(',')})(${currentShader.pivot.thread.join(',')})`
                } else {
                    thread.text = `$(pulse) (${currentShader.pivot.thread.join(',')})`
                }
                thread.tooltip = `Select different pivot thread for ${currentShader.name} ${singleThreadMode ? '' : '(all threads mode)'}`
                thread.show()
            } else {
                thread.hide()
            }
        }))
    }

    const connection = vscode.window.createStatusBarItem('deshader', vscode.StatusBarAlignment.Left, 1000)
    context.subscriptions.push(connection)
    connection.name = 'Deshader'

    function deshaderNotConnected() {
        vscode.commands.executeCommand('setContext', 'deshader.connected', false)

        connection.text = '$(plug) Deshader'
        connection.command = Commands.connect
        connection.tooltip = 'Click to connect to Deshader'
        connection.backgroundColor = undefined
        connection.color = undefined
        connection.show()
    }
    deshaderNotConnected()
    comm.onConnected.add(async () => {
        vscode.commands.executeCommand('setContext', 'deshader.connected', true)
        const u = comm.endpointURL
        if (u) {
            connection.text = "$(extension-deshader) " + u.host
            connection.tooltip = `Deshader connected (${comm.scheme}). Click to disconnect.`
            connection.command = Commands.disconnect
            connection.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground')
            connection.color = new vscode.ThemeColor('statusBarItem.remoteForeground')
        }
    })

    comm.onDisconnected.add(deshaderNotConnected)

    return {
        connection,
        updateSaveMode,
        updateThreadMode,
        mode,
        thread,
        deshaderNotConnected
    }
}