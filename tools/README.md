# Measuring a sandbox

Build the core package first, then sample an explicitly named container:

```sh
npm --workspace @sandboxer/core run build
npm run --silent measure -- sandboxer-acme-example 30 8001 /health > measurement.json
```

This diagnostic reads cgroup v2 memory and CPU counters and optionally probes a
loopback HTTP health endpoint inside the container. It neither starts nor changes
an environment, reads its credentials, nor collects application logs. It requires
Docker, cgroup v2, and `curl` inside the container for readiness probes.

Start the measurement before starting the container in another terminal to record
time to the first healthy response. `readyAfterMs` starts at the measurement's
start, not at `sandboxer up`; a container already healthy gives only probe latency.
Only a 2xx response counts as ready; a login redirect does not. No successful
response leaves it `null`. Collection is bounded to 1–600 seconds;
unavailable container samples are counted. No readable samples is an error.

`cpuSeconds` and `averageCpuPercent` cover the interval between the first and last
successful sample; 100% means one fully occupied CPU. `sampledPeakMemoryBytes` is
the largest observed current usage. `lifetimePeakMemoryBytes` is the kernel's peak
for the container's lifetime, which can include work before measurement began.
`finalMemoryBytes` is a final observation, not an assertion that the app is idle.
Readiness and sampling execs add a small measurement overhead. CPU use before the
first sample is not counted, and short memory spikes may be missed by sampling.

Compare the same image, machine, source revision and workload. Record fresh-volume,
resumed-volume and changed-source runs separately. Use a fresh container for each
peak comparison; retain the relevant volumes only for the resumed case. Measure
idle memory separately after health checks and builds have settled. Do not treat a
synthetic fixture's resource use as a production application's resource use.
