#!/usr/bin/env node

// @ts-check
import fs from 'fs'
import crypto from 'crypto'
import chokidar from 'chokidar'
import path from 'path'
import { Project, ClassDeclaration } from 'ts-morph'

const watch = process.argv[2] === 'watch'

let PLUGINS = []

fs.rmdirSync('./compile', { recursive: true })
fs.mkdirSync('./compile')

const project = new Project({
  tsConfigFilePath: './tsconfig.json'
})

let firstCompile = true
let compiling = false
const updateFileList = []
const compile = async () => {
  compiling = true
  const pluginIncs = []

  console.log('COMPILE_START')

  const dirtyFiles = []
  for (const { event, updatePath } of updateFileList) {
    if (['add', 'change'].includes(event)) {
      dirtyFiles.push(path.resolve(updatePath))
    }
    if (['add'].includes(event)) {
      project.addSourceFilesAtPaths(updatePath)
      project.resolveSourceFileDependencies()
    }
    if (['unlink'].includes(event)) {
      try {
        project.removeSourceFile(project.getSourceFileOrThrow(updatePath))
      } catch (e) {}
    }
  }

  const sourceFiles = project.getSourceFiles()

  const TypeMapping = {
    number: 'Number',
    string: 'String',
    boolean: 'Boolean',
    int: 'Int',
    bigint: 'BigInt',
    any: undefined,
    undefined: undefined,
    null: undefined
  }

  const getDeclareType = (declareLine, paramType) => {
    const parts = declareLine.split(/:(.*)/s)

    let type = undefined
    if (parts.length > 1) {
      type = parts[1]
        .replace(';', '')
        .replace(/[^=]=.+$/, '')
        .trim()
    }

    if (paramType.isUnion() && !paramType.isEnum() && !paramType.isBoolean()) {
      const unionTypes = paramType.getUnionTypes()
      const enumJSON = {}
      for (const ut of unionTypes) {
        if (ut.isStringLiteral()) {
          const suv = ut.getText().replace(/^['"]/, '').replace(/['"]$/, '')
          enumJSON[suv] = suv
        } else {
          return undefined
        }
      }
      return JSON.stringify(enumJSON)
    } else if (paramType.isArray()) {
      type = type.replace('[]', '')
      const pType = paramType.getArrayElementTypeOrThrow()
      if (pType.isClass() || pType.isEnum()) {
      } else {
        type = TypeMapping[type]
      }
    } else if (paramType.isClass() || paramType.isEnum()) {
    } else {
      type = TypeMapping[type]
    }

    return type
  }

  const addPropDecorator = (cls, sourceFile) => {
    if (!cls) {
      return
    }
    cls.getProperties().forEach((p) => {
      let type = getDeclareType(p.getText(), p.getType())
      if (type === undefined || type === null) {
        return
      }

      if (!p.hasQuestionToken()) {
        if (!p.getDecorators().find((d) => d.getName() === '_Required')) {
          p.addDecorator({ name: '_Required', arguments: [] })
        }
      }

      if (!p.getDecorators().find((d) => d.getName() === '_PropDeclareType')) {
        p.addDecorator({ name: '_PropDeclareType', arguments: [type] })
      }
    })
    if (cls.getExtends()) {
      addPropDecorator(cls.getExtends().getExpression().getType().getSymbolOrThrow().getDeclarations()[0], sourceFile)
    }
  }

  let importFilesList = []

  for (const sf of sourceFiles) {
    ;['default.config.ts', process.env.SUMMER_ENV + '.config.ts'].forEach((configFileName) => {
      if (sf.getFilePath().indexOf(configFileName) > 0) {
        const refSourceFiles = sf.getReferencedSourceFiles()
        refSourceFiles.forEach((refSourceFile) => {
          if (refSourceFile.getText().indexOf('SummerPlugin') > 0) {
            const found = refSourceFile.getFilePath().match(/@summer-js\/[^/]+/)
            if (found) {
              if (found[0] !== '@summer-js/summer') {
                PLUGINS.push(found[0])
              }
            }
          }
        })
      }
    })
  }

  PLUGINS = Array.from(new Set(PLUGINS))
  importFilesList.push(...PLUGINS)

  for (const plugin of PLUGINS) {
    if (fs.existsSync('./node_modules/' + plugin) || fs.existsSync('../../node_modules/' + plugin)) {
      const p = await import(plugin)
      const P = p.default.default
      pluginIncs.push(new P())
    }
  }

  const autoImportDecorators = ['Middleware', 'Controller']
  for (const p of pluginIncs) {
    if (p.autoImportDecorators) {
      const aids = p.autoImportDecorators()
      autoImportDecorators.push(...aids)
    }
  }

  let compileCounter = 0
  for (const sf of sourceFiles) {
    compileCounter++

    if (sf.getFilePath().endsWith('.d.ts') || (watch && sf.getFilePath().endsWith('.test.ts'))) {
      continue
    }

    // add import file list
    for (const cls of sf.getClasses()) {
      for (const classDecorator of cls.getDecorators()) {
        if (autoImportDecorators.includes(classDecorator.getName())) {
          importFilesList.push(
            cls
              .getSourceFile()
              .getFilePath()
              .replace(path.resolve() + '/src', '.')
          )
        }
      }
    }

    if (!firstCompile && !dirtyFiles.includes(sf.getFilePath())) {
      continue
    }

    sf.refreshFromFileSystemSync()
    for (const cls of sf.getClasses()) {
      addPropDecorator(cls, sf)
      for (const classDecorator of cls.getDecorators()) {
        if (classDecorator.getName() === 'Controller') {
          cls.getMethods().forEach((cMethod) => {
            cMethod.getParameters().forEach((param) => {
              if (param.getDecorators().length > 0) {
                const paramType = param.getType()
                param.addDecorator({
                  name: '_ParamDeclareType',
                  arguments: [getDeclareType(param.getText(), paramType)]
                })
              }
            })
          })
        }
      }
      for (const p of pluginIncs) {
        p.compile && (await p.compile(cls))
        for (const classDecorator of cls.getDecorators()) {
          if (autoImportDecorators.includes(classDecorator.getName())) {
            importFilesList.push(
              cls
                .getSourceFile()
                .getFilePath()
                .replace(path.resolve() + '/src', '.')
            )
          }
        }
      }
    }

    console.log('COMPILE_PROGRESS(' + compileCounter + '/' + sourceFiles.length + ')')
  }

  console.log('COMPILE_PROGRESS')

  let fileContent = '// this file is generated by compiler\n'
  fileContent += 'process.env.SUMMER_ENV = "' + (process.env.SUMMER_ENV || '') + '"\n'

  if (fs.existsSync('./src/config/default.config.ts')) {
    if (fs.readFileSync('./src/config/default.config.ts', { encoding: 'utf-8' }).trim().length > 0) {
      fileContent += 'import * as defaultConfig from "./config/default.config"\n'
      fileContent += 'global["$$_DEFAULT_CONFIG"] = defaultConfig\n'
    }
  }

  if (fs.existsSync(`./src/config/${process.env.SUMMER_ENV}.config.ts`)) {
    if (fs.readFileSync(`./src/config/${process.env.SUMMER_ENV}.config.ts`, { encoding: 'utf-8' }).trim().length > 0) {
      fileContent += `import * as envConfig from "./config/${process.env.SUMMER_ENV}.config";\n`
      fileContent += 'global["$$_ENV_CONFIG"] = envConfig\n'
    }
  }

  Array.from(new Set(importFilesList)).forEach((path, inx) => {
    fileContent += `import '${path.replace(/\.ts$/, '')}'\n`
  })

  fs.writeFileSync('./src/auto-imports.ts', fileContent)
  project.getSourceFileOrThrow('./src/auto-imports.ts').refreshFromFileSystemSync()

  const diagnostics = project.getPreEmitDiagnostics()
  if (diagnostics.length > 0) {
    console.error('\x1b[31m%s\x1b[0m', 'Error compiling source code:')
    console.log(project.formatDiagnosticsWithColorAndContext(diagnostics))
    compiling = false
    firstCompile = false
    return
  }

  project.emitSync()

  for (const p of pluginIncs) {
    p.postCompile && (await p.postCompile())
  }

  firstCompile = false
  updateFileList.splice(0, updateFileList.length)
  console.log('COMPILE_DONE')
  compiling = false
}

if (watch) {
  const fileHashes = {}
  const watchDir = './src/'
  const watcher = chokidar
    .watch(watchDir, {
      ignored: 'src/auto-imports.ts',
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 }
    })
    .on('all', async (event, path) => {
      if (fs.existsSync('./' + path)) {
        if (fs.lstatSync('./' + path).isDirectory()) {
          return
        }
        const md5 = crypto.createHash('md5')
        const currentMD5 = md5.update(fs.readFileSync('./' + path).toString()).digest('hex')

        if (!fileHashes[path] && firstCompile) {
          fileHashes[path] = currentMD5
          return
        }

        // if (currentMD5 === fileHashes[path]) {
        //   return
        // }

        fileHashes[path] = currentMD5
      } else {
        delete fileHashes[path]
      }
      updateFileList.push({ event, updatePath: path })
      if (compiling || firstCompile) {
        return
      }
      await compile()
    })

  watcher.on('ready', async () => {
    await compile()
  })
} else {
  compile()
}
