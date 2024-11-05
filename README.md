# deshader-vscode README

This extension "deshader-vscode" companions Deshader on its way to debug your shaders.

## Features
- Shader step debugging
- Resources introspection

# Usage

## Requirements
There are multiple ways how to use Deshader in your project:
1. **MOST TYPICAL**: [Deshader](https://github.com/osdvf/deshader) must be installed on your system
2. This extension can install Deshader internally
3. Your application can be compiled with Deshader embedded

## Ways how to use

### Launching your application from VSCode and injecting Deshader automatically
Create a debug profile in `.vscode/launch.json` pointing to your application:
```json
{
    "configurations": [
        {
            "name": "Debug Shaders",
            "type": "deshader",
            "request": "launch",
            "program": "${workspaceFolder}/path/to/your/application"
        }
    ]
}
```

### Launching the application using Deshader Launcher
This approach doesn't even require VSCode to be installed on your system, because Deshader itself embeds VSCode.    
Guide is in [Deshader documentation](https://github.com/OSDVF/deshader/blob/main/guide/GUI.md).

# Extension
## Building
```bash
bun install
bun compile-dev
```
