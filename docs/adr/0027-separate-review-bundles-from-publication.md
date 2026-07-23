# Separate Review Bundles from publication

Auto-QA v1 creates a provider-neutral Review Bundle with Markdown, selected screenshots and recordings, and a publication manifest, while retaining raw traces and diagnostic evidence separately as more sensitive artifacts. Auto-QA itself never holds forge credentials or posts externally; a first-party GitHub Actions recipe uploads artifacts, writes a Job Summary, and links or comments on the pull request, leaving richer media hosting and other forge publishers behind a future publication seam.
