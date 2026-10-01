import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const out = flag('--out') ?? 'Formula/review.rb'
const version = flag('--version')
const binaries = flag('--binaries')

const header = `class Review < Formula
  desc "Open a guided review in the browser and wait until it is submitted"
  homepage "https://github.com/marksalpeter/guided-reviews"
  license "MIT"
`

const test = `
  test do
    assert_match "Submit", shell_output("#{bin}/review --help")
  end
end
`

await mkdir(dirname(out), { recursive: true })
await writeFile(out, version ? await stable(version, binaries) : headOnly())

/** headOnly is the formula used before a GitHub release exists. */
function headOnly() {
  return `${header}
  head "https://github.com/marksalpeter/guided-reviews.git", branch: "main"

  depends_on "node" => :build

  def install
    system "npm", "ci"
    system "npm", "run", "build:bin"
    bin.install "dist/review"
  end
${test}`
}

/** stable points each platform at the release binary and keeps a source build for --HEAD. */
async function stable(version, dir) {
  if (!dir) {
    throw new Error('--binaries is required with --version')
  }
  const names = ['review-macos-arm64', 'review-macos-x64', 'review-linux-arm64', 'review-linux-x64']
  const sums = {}
  for (const name of names) {
    sums[name] = createHash('sha256').update(await readFile(join(dir, name))).digest('hex')
  }
  const asset = name => `https://github.com/marksalpeter/guided-reviews/releases/download/v${version}/${name}`
  const block = name => `      url "${asset(name)}"\n      sha256 "${sums[name]}"`
  return `${header}  version "${version}"

  on_macos do
    on_arm do
${block('review-macos-arm64')}
    end
    on_intel do
${block('review-macos-x64')}
    end
  end

  on_linux do
    on_arm do
${block('review-linux-arm64')}
    end
    on_intel do
${block('review-linux-x64')}
    end
  end

  head "https://github.com/marksalpeter/guided-reviews.git", branch: "main"

  depends_on "node" => :build if build.head?

  def install
    if build.head?
      system "npm", "ci"
      system "npm", "run", "build:bin"
      bin.install "dist/review"
    elsif OS.mac?
      if Hardware::CPU.arm?
        bin.install "review-macos-arm64" => "review"
      else
        bin.install "review-macos-x64" => "review"
      end
    elsif Hardware::CPU.arm?
      bin.install "review-linux-arm64" => "review"
    else
      bin.install "review-linux-x64" => "review"
    end
  end
${test}`
}

/** flag reads one --name value from the command line. */
function flag(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
