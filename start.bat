@echo off
if not defined AIRWRITE_HOST set AIRWRITE_HOST=0.0.0.0
if not defined AIRWRITE_PORT set AIRWRITE_PORT=8000
if not exist .venv\Scripts\python.exe (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3.11 or activate an environment that provides python.
    pause
    exit /b 1
  )
  python -m venv .venv
  if errorlevel 1 (
    echo Could not create the virtual environment.
    pause
    exit /b 1
  )
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
.venv\Scripts\python.exe -m uvicorn app:app --host %AIRWRITE_HOST% --port %AIRWRITE_PORT%
