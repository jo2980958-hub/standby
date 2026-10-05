# Standby

Readiness pack for households that depend on electricity at home. For each person and device (oxygen concentrator, ventilator, CPAP, refrigerated insulin, generator) it shows how many hours of backup there are against the longest outage that county actually had, marks each item Covered / Short / Gap / Check, and lists what to do before the power goes.

Live: https://9usmdb95hw.ap-northeast-1.awsapprunner.com

## NVIDIA Nemotron and Nebius Token Factory
- `backend/engine.py` computes status and hours: manufacturer runtimes (Inogen One G5, ResMed Astral, AirSense 11 converter) against the EAGLE-I county record (hours with 10% or more of customers out). Planned backup is half the manual's best or typical figure.
- `backend/agent.py` sends those facts to `nvidia/nemotron-3-super-120b-a12b` on Nebius Token Factory (`reasoning_effort=low`). Nemotron writes the requirement, gap and actions per item, the decision (stay or leave), the priority list, and flags devices missing from the list. It cannot change a status or a number: any number not in the facts triggers a retry.
- Three example households are pre-computed in `backend/cache/`. "Run it" and the New household form make one live call.
- Key: set `NEBIUS_API_KEY` (server side only).
- Every model call runs on Nebius Token Factory, which is serverless and OpenAI-compatible, so one base URL and the standard OpenAI client reached every model with no GPU and no dedicated endpoint to provision. That is what let this be built and deployed quickly. Other models: none. No other model is used; hours and statuses are classical code in `engine.py`.

## Run
    pip install -r backend/requirements.txt
    NEBIUS_API_KEY=... ./run.sh        # http://localhost:8008
    docker build -t standby . && docker run -p 8080:8080 -e NEBIUS_API_KEY=... standby

UI is plain HTML/CSS/JS in `web/` (no build step).
`backend/build_data.py` rebuilds `data/events.json` from the research files.

Data: EAGLE-I (ORNL, CC BY 4.0), National Weather Service products, HHS emPOWER public service, manufacturer manuals. Images: NASA/NOAA, NOAA (public domain).

Stack: Python, FastAPI, plain JS frontend, NVIDIA Nemotron on Nebius Token Factory.

Licensed under the Apache License 2.0.
