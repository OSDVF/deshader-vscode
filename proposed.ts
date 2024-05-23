import * as fs from 'fs'

const name = "vscode.proposed.debugFocus.d.ts"

fetch("https://raw.githubusercontent.com/microsoft/vscode/c4653faeb1dac658945e8792b5858ef95b2da3d7/src/vscode-dts/" + name).then(async req => {
    const text = await req.text()
    fs.writeFileSync(name, text)
}).catch(err => {
    if (fs.existsSync(name)) {
        console.warn(err, "Error happened, but the file " + name + " exists, so it will be ignored")
    }
    else {
        console.error(err)
    }
})