Use the Slack tools to fetch/refresh recent Slack messages available to me across my workspace from the start of today in my local timezone up to now.

Search channels, DMs, and threads available to me. Read relevant message context and thread replies before deciding.

Find every GitHub pull request that requires my attention to review. A PR requires my attention only when the message or thread tags me directly, mentions my name/display name, asks me to review, asks for my approval, or otherwise clearly implies I am the intended reviewer.

My Slack user ID is: U09F7PGF4AJ.

Keep only PRs whose repository name is exactly `world` or `index-serving`. For each candidate, verify the PR is still open and not merged before including it. Exclude merged PRs, closed PRs, already-completed review requests, and PRs from all other repositories.

Write a JSON object with this shape:

```json
{
  "prs": [
    {
      "number": 123,
      "repo": "world",
      "title": "PR title",
      "url": "https://github.com/<owner>/<world-or-index-serving>/pull/123",
      "author": "author if known",
      "channelName": "channel if known",
      "slackPermalink": "message permalink if known",
      "reason": "why this needs my review",
      "threadStatus": "notable status from the thread if any"
    }
  ]
}
```

If no unmerged `world` or `index-serving` PRs need my review, write `{"prs":[]}`.

Do not modify source code.
