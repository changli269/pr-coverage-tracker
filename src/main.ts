import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'
import * as cache from '@actions/cache'
import {getCoverageComment} from './compare-coverage'
import {mv} from '@actions/io'
import * as fs from 'fs'

async function run(): Promise<void> {
  try {
    const currentCoverageFile: string = core.getInput('coverage-path', {
      required: true
    })
    const previousCoverageFile: string = core.getInput(
      'reference-coverage-path'
    )

    const token = core.getInput('token', {required: true})

    const octokit = getOctokit(token)

    let sha: string | undefined
    let branchName: string
    if (context.eventName === 'pull_request') {
      const pr = await octokit.rest.pulls.get({
        pull_number: context.issue.number,
        owner: context.issue.owner,
        repo: context.issue.repo
      })

      // Restore previous coverage to compare with from cache
      const restoreKey = `${process.platform}-${
        context.eventName === 'pull_request'
          ? pr.data.base.ref
          : pr.data.head.ref
      }-prev-`
      const previousCoverageRecoveredKey = await cache.restoreCache(
        [core.getInput('reference-coverage-path')],
        restoreKey,
        [restoreKey]
      )

      if (previousCoverageRecoveredKey) {
        core.info(
          `Restoring previous coverage from cache key ${previousCoverageRecoveredKey}...`
        )
      } else {
        core.warning(
          `Couldnt get previous coverage from cache key ${restoreKey}`
        )
      }

      sha = previousCoverageRecoveredKey
        ? /prev-([^-]+)-.*$/.exec(previousCoverageRecoveredKey)?.[1]
        : undefined
      if (sha) {
        core.info(`Reference coverage was calculated for commit ${sha}`)
      }

      branchName = pr.data.head.ref
    } else {
      branchName = context.ref.replace(/^refs\/heads\//, '')
    }

    const comment = getCoverageComment({
      commitId: context.sha,
      currentCoverageFile,
      previousCommitId: sha,
      previousCoverageFile
    })

    core.info(comment)

    fs.writeFileSync('comment.md', comment)

    // Cache coverage as reference
    await mv(currentCoverageFile, previousCoverageFile, {force: true})
    // Check if cache key already exists; list caches and delete matching entry to avoid save failure
    const targetKey = `${process.platform}-${branchName}-prev-${context.sha}`
    try {
      const listResp = await octokit.request(
        'GET /repos/{owner}/{repo}/actions/caches',
        {
          owner: context.repo.owner,
            repo: context.repo.repo,
            per_page: 100
        }
      )
      const caches: any[] =
        (listResp.data as any).actions_caches || (listResp.data as any).caches || []
      const existing = caches.find(c => c.key === targetKey)
      if (existing) {
        core.info(
          `Cache key ${targetKey} already exists (id=${existing.id}), deleting it before saving new one.`
        )
        await octokit.request(
          'DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}',
          {
            owner: context.repo.owner,
            repo: context.repo.repo,
            cache_id: existing.id
          }
        )
      } else {
        core.info(`Cache key ${targetKey} does not exist yet; will create new cache.`)
      }
    } catch (e) {
      core.warning(`Could not verify existing cache keys: ${(e as Error).message}`)
    }
    await cache.saveCache(
      [previousCoverageFile],
      targetKey
    )

    core.setOutput('comment-file', 'comment.md')
    core.setOutput('comment', comment)
  } catch (error) {
    core.error('Something went wrong')
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
