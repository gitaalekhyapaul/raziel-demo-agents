# Historical SDK Candidate

This directory retains the reviewed B-0066 packaged SDK candidate as historical
evidence. The agents now consume public npm package
`@gitaalekhyapaul/raziel-sdk-ts@0.1.0` through the manifest and lockfile. The Docker
build does not copy or install this tarball.

- SDK commit: `e7f1cd6b354f236f0323d9d19aa4a431c5dfa470`
- Tarball SHA-256: `556abe87978429a1542bfbbe8d81edd48a8be92ceeb07b1731eb18e8233ce572`
- Backend checkpoint: `c5efbfb025fc488f1f47dfb65d21f268b5eb521f`

The public release preserves this candidate's compiled SDK byte-for-byte. Its
README and release metadata differ. Use the public registry for later agent
dependency updates. Do not overwrite this historical candidate.
