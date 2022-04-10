#!/usr/bin/env node

import { exec, execSync, spawn } from 'child_process'
import kill from 'tree-kill'
import fs from 'fs'
import { program } from 'commander'
import ora from 'ora'

program.option('-t, --test').option('-s, --serve').option('-b, --build').option('--env [char]', '', '')
program.parse()

const options = program.opts()

const clearScreen = () => process.stdout.write(process.platform === 'win32' ? '\x1Bc' : '\x1B[2J\x1B[3J\x1B[H')

let spinner

const printProcessData = (p) => {
  p.stdout.on('data', (data) => {
    spinner.stop()
    process.stdout.write(data)
  })

  p.stderr.on('data', (data) => {
    spinner.stop()
    process.stdout.write(data)
  })

  p.on('error', (data) => {
    spinner.stop()
    //@ts-ignore
    process.stdout.write(data)
  })
}

if (options.serve) {
  let childProcess = null
  let childProcess2 = null
  spinner = ora('Compiling...')

  const serve = () => {
    try {
      if (childProcess) {
        kill(childProcess.pid)
        childProcess = null
      }

      childProcess = exec(`cross-env SUMMER_ENV=${options.env} summer-compile`)
      childProcess.stdout.on('data', (data) => {
        if (data.startsWith('COMPILE_START')) {
          clearScreen()
          spinner.start()
          if (childProcess2) {
            kill(childProcess2.pid)
            childProcess2 = null
          }
        } else if (data.startsWith('COMPILE_DONE')) {
          if (!fs.existsSync('./compile/index.js')) {
            return
          }
          childProcess2 = spawn('node', ['--enable-source-maps', './compile/index.js'])
          printProcessData(childProcess2)
          setTimeout(() => {
            spinner.stop()
          }, 3000)
        } else {
          process.stdout.write(data)
        }
      })

      childProcess.stderr.on('data', (data) => {
        if (childProcess2) {
          kill(childProcess2.pid)
          childProcess2 = null
        }
        spinner.stop()
        process.stdout.write(data)
      })

      childProcess.on('error', (data) => {
        if (childProcess2) {
          kill(childProcess2.pid)
          childProcess2 = null
        }
        spinner.stop()
        //@ts-ignore
        process.stdout.write(data)
      })
    } catch (e) {
      console.log(e)
    }
  }
  serve()
} else if (options.test) {
  spinner = ora('Preparing...')
  spinner.start()
  const compileProcess = exec(`rm -rdf ./compile/* && cross-env SUMMER_ENV=${options.env} summer-compile`)
  printProcessData(compileProcess)

  compileProcess.on('exit', () => {
    spinner.stop()
    if (fs.existsSync('./compile/index.js')) {
      const testProcess = exec(' jest --colors')
      printProcessData(testProcess)
    }
  })
} else if (options.build) {
  spinner = ora('Building ...')
  spinner.start()
  const compileProcess = exec(`rm -rdf ./compile/* && cross-env SUMMER_ENV=${options.env} summer-compile`)
  printProcessData(compileProcess)
  compileProcess.on('exit', (code) => {
    if (fs.existsSync('./compile/index.js')) {
      if (fs.existsSync('./resource')) {
        if (!fs.existsSync('./build')) {
          fs.mkdirSync('./build')
        }
        if (!fs.existsSync('./build/resource')) {
          fs.mkdirSync('./build/resource')
        }
        exec('cp -r ./resource/* ./build/resource')
      }
      spinner.stop()
      const buildProcess = exec(
        'npx esbuild ./compile/index.js --bundle --sourcemap --platform=node --outfile=./build/index.js'
      )
      printProcessData(buildProcess)
    }
    spinner.stop()
  })
}
