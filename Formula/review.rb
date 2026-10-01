class Review < Formula
  desc "Open a guided review in the browser and wait until it is submitted"
  homepage "https://github.com/marksalpeter/guided-reviews"
  license "MIT"

  head "https://github.com/marksalpeter/guided-reviews.git", branch: "main"

  depends_on "node" => :build

  def install
    system "npm", "ci"
    system "npm", "run", "build:bin"
    bin.install "dist/review"
  end

  test do
    assert_match "Submit", shell_output("#{bin}/review --help")
  end
end
