# RepoQL GitHub Samples

Ready-to-use ways to put [RepoQL](https://github.com/RepoQL/RepoQL) to work on GitHub. Each sample is a folder you can use as it is, or copy into your own repository and change.

| Sample | What it does |
|--------|--------------|
| [`review-agent`](review-agent/) | A code review agent for pull requests. Claude Code or Codex reviews every push with RepoQL, posts one GitHub review with a thread per finding, and continues the same session across pushes. It is built from GitHub Actions you reference as `RepoQL/Github.Samples/review-agent/<action>@v1`. |

Start with the sample's README. For the review agent, that is [`review-agent/README.md`](review-agent/README.md), and its [starter workflow](review-agent/starter/review.yml) is the file to copy.

## License

[MIT](LICENSE).
