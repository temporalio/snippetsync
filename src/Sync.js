const { join, basename, dirname } = require('path');
const { Octokit } = require('@octokit/rest');
const { promisify } = require('util');
const { eachLine } = require('line-reader');
const { fmtStartCodeBlock, markdownCodeTicks,extractionDir, fmtProgressBar, readStart, readEnd, rootDir, writeStart, writeStartClose, writeEnd } = require('./common');
const { writeFile, unlink } = require('fs');
const arrayBuffToBuff = require('arraybuffer-to-buffer');
const anzip = require('anzip');
const readdirp = require('readdirp');
const rimraf = require('rimraf');
const progress = require('cli-progress');
const glob = require('glob');

// Convert dependency functions to return promises
const writeAsync = promisify(writeFile);
const unlinkAsync = promisify(unlink);
const eachLineAsync = promisify(eachLine);
const rimrafAsync = promisify(rimraf);
// Snippet class contains info and methods used for passing and formatting code snippets
class Snippet {
  constructor (id, ext, owner, repo, ref, filePath) {
    this.id = id;
    this.ext = ext;
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.filePath = filePath;
    this.lines = [];
  }
  // fmt creates an array of file lines from the Snippet variables
  fmt(fmtSourceLink) {
    const lines = [];
    if (fmtSourceLink) {
      lines.push(this.fmtSourceLink());
    }
    lines.push(fmtStartCodeBlock(this.ext));
    lines.push(...this.lines);
    lines.push(markdownCodeTicks);
    return lines;
  }
  // fmtSourceLink creates a markdown link to the source of the snippet
  fmtSourceLink() {
    const url = this.buildURL();
    const path = this.buildPath();
    const link = `[${path}](${url})`;
    return link;
  }
  // buildPath creates a string that represents the relative path to the snippet
  buildPath() {
    const sourceURLParts = this.filePath.directory.split('/');
    const path = [
      ...(sourceURLParts.slice(1, sourceURLParts.length)),
      this.filePath.name,
    ].join('/');
    return path;
  }
  // buildURL creates a url to the snippet source location
  buildURL() {
    const sourceURLParts = this.filePath.directory.split('/');
    let ref = "";
    if (this.ref !== "" && this.ref !== undefined) {
      ref = this.ref;
    } else {
      ref = "master";
    }
    const url = [
      'https://github.com',
      this.owner,
      this.repo,
      "blob",
      ref,
      ...(sourceURLParts.slice(1, sourceURLParts.length)),
      this.filePath.name,
    ].join('/');
    return url;
  }
}
// Repo is the class that maps repo configuration to local filepaths
class Repo {
  constructor(owner, repo, ref) {
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.filePaths = [];
  }
}
// File is the class that contains a filename and lines of the file
class File {
  constructor(filename, fullpath) {
    this.filename = filename;
    this.fullpath = fullpath;
    this.lines = [];
  }

  fileString() {
    return `${this.lines.join("\n")}\n`
  }
}
// Sync is the class of methods that can be used to do the following:
// Download repos, extract code snippets, merge snippets, and clear snippets from target files
class Sync {
  constructor(cfg, logger) {
    this.config = cfg;
    this.origins = cfg.origins;
    this.logger = logger;
    const octokit = new Octokit();
    this.github = octokit;
  }
  // run is the main method of the Sync class that downloads, extracts, and merges snippets
  async run() {
    // Download repo as zip file.
    // Extract to sync_repos directory.
    // Get repository details and file paths.
    const repositories = await this.getRepos();
    // Search each origin file and scrape the snippets
    const snippets = await this.extractSnippets(repositories);
    // Get the infos (name, path) of all the files in the target directories
    let targetFiles = await this.getTargetFilesInfos();
    // Add the lines of each file
    targetFiles = await this.getTargetFilesLines(targetFiles);
    // Splice the snippets in the file objects
    const splicedFiles = await this.spliceSnippets(snippets, targetFiles);
    // Overwrite the files to the target directories
    await this.writeFiles(splicedFiles);
    // Delete the sync_repos directory
    await this.cleanUp();
    this.logger.info("Snippet sync operation complete!");
    return;
  }
  // clear is the method that will remove snippets from target merge files
  async clear() {
    const filePaths = await this.getTargetFilesInfos();
    const files = await this.getTargetFilesLines(filePaths);
    const filesToWrite = await this.clearSnippets(files);
    await this.writeFiles(filesToWrite);
    this.logger.info("Snippets have been cleared.");
  }
  // getRepos is the method that downloads all of the Github repos
  async getRepos() {
    const repositories = [];
    await Promise.all(
      this.origins.map(async (origin) => {
        if ('files' in origin) {
          repositories.push({
            owner: 'local',
            repo: 'local',
            filePaths: origin.files.flatMap((pattern) => glob.sync(pattern).map((f) => ({
              name: basename(f), directory: dirname(f)
            }))),
          });
          return;
        }
        if (!('owner' in origin && 'repo' in origin)) {
          throw new Error(`Invalid origin: ${JSON.stringify(origin)}`);
        }
        const { owner, repo, ref } = origin;
        const repository = new Repo(owner, repo, ref);
        const dlProgress = new progress.Bar(
          {
            format: fmtProgressBar(`downloading repo ${join(owner, repo)}`),
            barsize: 20,
          },
          progress.Presets.shades_classic
        );
        dlProgress.start(3, 0);
        const byteArray = await this.getArchive(owner, repo, ref);
        dlProgress.increment();
        const fileName = `${repo}.zip`;
        const buffer = arrayBuffToBuff(byteArray);
        await writeAsync(fileName, buffer);
        dlProgress.increment();
        repository.filePaths = await this.unzip(fileName);
        repositories.push(repository);
        dlProgress.increment();
        dlProgress.stop();
      })
    );
    return repositories;
  }
  // unzip unzips the Github repo archive
  async unzip(filename) {
    const zipPath = join(rootDir, filename);
    const unzipPath = join(rootDir, extractionDir);
    const { files } = await anzip(zipPath, { outputPath: unzipPath });
    await unlinkAsync(zipPath);
    return files;
  }
  // getArchive gets the Github repo archive from Github
  async getArchive(owner, repo, ref) {
    const result = await this.github.repos.downloadArchive({
      owner,
      repo,
      ref,
      archive_format: "zipball",
    });
    return result.data;
  }
  // extractSnippets returns an array of code snippets that are found in the repositories
  async extractSnippets(repositories) {
    const snippets = [];
    await Promise.all(
      repositories.map(async ({ owner, repo, ref, filePaths }) => {
        const extractSnippetProgress = new progress.Bar(
          {
            format: fmtProgressBar(`extracting snippets from ${owner}/${repo}`),
            barsize: 20,
          },
          progress.Presets.shades_classic
        );
        extractSnippetProgress.start(filePaths.length + 1, 0);
        const extractRootPath = join(rootDir, extractionDir);
        for (const item of filePaths) {
          extractSnippetProgress.increment();
          const ext = determineExtension(item.name);
          let path = join(item.directory, item.name);
          if (!(owner === 'local' && repo === 'local')) {
            path = join(extractRootPath, path);
          }
          let capture = false;
          let fileSnipsCount = 0;
          const fileSnips = [];
          await eachLineAsync(path, (line) => {
            if (line.includes(readEnd)) {
              capture = false;
              fileSnipsCount++;
            }
            if (capture) {
              fileSnips[fileSnipsCount].lines.push(line);
            }
            if (line.includes(readStart)) {
              capture = true;
              const id = extractReadID(line);
              const snip = new Snippet(id, ext, owner, repo, ref, item);
              fileSnips.push(snip);
            }
          });
          snippets.push(...fileSnips);
        }
        extractSnippetProgress.increment();
        extractSnippetProgress.stop();
      })
    );
    return snippets;
  }
  // getTargetFilesInfos identifies the paths to the target write files
  async getTargetFilesInfos() {
    const readTargetDirectoryProgress = new progress.Bar(
      {
        format: fmtProgressBar("loading info for each target directory"),
        barsize: 20,
      },
      progress.Presets.shades_classic
    );
    readTargetDirectoryProgress.start(1, 0);
    const targetFiles = [];
    for (const target of this.config.targets) {
      const targetDirPath = join(rootDir, target);
      for await (const entry of readdirp(targetDirPath)) {
        const file = new File(entry.basename, entry.fullPath);
        targetFiles.push(file);
        readTargetDirectoryProgress.setTotal(targetFiles.length);
        readTargetDirectoryProgress.increment();
      }
      readTargetDirectoryProgress.stop();
    }
    return targetFiles;
  }
  // getTargetFilesLines loops through the files and calls readLines on each one
  async getTargetFilesLines(targetFiles) {
    const getInsertFilesProgress = new progress.Bar(
      {
        format: fmtProgressBar("reading file lines for each target file"),
        barsize: 20,
      },
      progress.Presets.shades_classic
    );
    getInsertFilesProgress.start(targetFiles.length, 0);
    const updatedFiles = [];
    for (const targetFile of targetFiles) {
      updatedFiles.push(await this.readLines(targetFile));
      getInsertFilesProgress.increment();
    }
    getInsertFilesProgress.stop();
    return updatedFiles;
  }
  // readLines reads each line of the file
  async readLines(targetFile) {
    const fileLines = [];
    await eachLineAsync(targetFile.fullpath, (line) => {
      fileLines.push(line);
    });
    targetFile.lines = fileLines;
    return targetFile;
  }
  // spliceSnippets merges the snippet into the target location of a file
  async spliceSnippets(snippets, files) {
    const spliceProgress = new progress.Bar(
      {
        format: fmtProgressBar("starting splice operations"),
        barsize: 20,
      },
      progress.Presets.shades_classic
    );
    spliceProgress.start(snippets.length, 0);
    for (const snippet of snippets) {
      spliceProgress.increment();
      for (let file of files) {
        file = await this.getSplicedFile(snippet, file);
      }
    }
    spliceProgress.stop();
    return files;
  }
  // getSplicedFile returns the the spliced file
  async getSplicedFile(snippet, file) {
    const staticFile = file;
    let dynamicFile = file;
    let fileLineNumber = 1;
    let lookForStop = false;
    let spliceStart = 0;
    let config;
    for (let [idx, _] of staticFile.lines.entries()) {
      const line = file.lines[idx];
      if (line.includes(writeStart)) {
        const extracted = extractWriteIDAndConfig(line);
        if (extracted.id === snippet.id) {
          config = extracted.config;
          spliceStart = fileLineNumber;
          lookForStop = true;
        }
      }
      if (line.includes(writeEnd) && lookForStop) {
        dynamicFile = await this.spliceFile(
          spliceStart,
          fileLineNumber,
          snippet,
          dynamicFile,
          config || this.config.features
        );
        lookForStop = false;
      }
      fileLineNumber++;
    }
    return dynamicFile;
  }
  // spliceFile merges an individual snippet into the file
  async spliceFile(start, end, snippet, file, config) {
    const rmlines = end - start;
    file.lines.splice(start, rmlines - 1, ...snippet.fmt(config.enable_source_link));
    return file;
  }
  // clearSnippets loops through target files to remove snippets
  async clearSnippets(files) {
    const clearProgress = new progress.Bar(
      {
        format: fmtProgressBar("starting clear operations"),
        barsize: 20,
      },
      progress.Presets.shades_classic
    );
    clearProgress.start(files.length, 0);
    for (let file of files) {
      file = await this.getClearedFile(file);
      clearProgress.increment();
    }
    clearProgress.stop();
    return files;
  }
  // getClearedFile removes snippet lines from a specific file
  async getClearedFile(file) {
    let omit = false;
    const newFileLines = [];
    for (const line of file.lines) {
      if (line.includes(writeEnd)) {
        omit = false;
      }
      if (!omit) {
        newFileLines.push(line);
      }
      if (line.includes(writeStart)) {
        omit = true;
      }
    }
    file.lines = newFileLines;
    return file;
  }
  // writeFiles writes file lines to target files
  async writeFiles(files) {
    const writeFileProgress = new progress.Bar(
      {
        format: fmtProgressBar("writing files"),
        barsize: 20,
      },
      progress.Presets.shades_classic
    );
    writeFileProgress.start(files.length, 0);
    for (const file of files) {
      await writeAsync(file.fullpath, file.fileString());
      writeFileProgress.increment();
    }
    writeFileProgress.stop();
    return;
  }
  // cleanUp deletes temporary files and folders
  async cleanUp() {
    const cleanupProgress = new progress.Bar(
      {
        format: fmtProgressBar("cleaning up downloads"),
        barsize: 20,
      },
      progress.Presets.shades_classic
    );
    cleanupProgress.start(1, 0);
    const path = join(rootDir, extractionDir);
    rimrafAsync(path);
    cleanupProgress.update(1);
    cleanupProgress.stop();
  }
}
// determineExtension returns the file extension
function determineExtension(path) {
    const parts = path.split(".");
    return parts[parts.length - 1];
}

// See: https://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex
function escapeStringRegexp(string) {
  return string
    .replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
    .replace(/-/g, '\\x2d');
}

const readMatchRegexp = new RegExp(escapeStringRegexp(readStart) + /\s+(\S+)/.source);

const writeMatchRegexp = new RegExp(
  escapeStringRegexp(writeStart)
  + /\s+(\S+)(?:\s+(.+))?\s*/.source
  + escapeStringRegexp(writeStartClose));

// extractReadID uses regex to exract the id from a string
function extractReadID(line) {
  const matches = line.match(readMatchRegexp);
  return matches[1];
}

// extractWriteIDAndConfig uses regex to exract the id from a string
function extractWriteIDAndConfig(line) {
  const matches = line.match(writeMatchRegexp);
  return { id: matches[1], config: matches[2] ? JSON.parse(matches[2]) : undefined };
}

module.exports = { Sync };
