#!/usr/bin/env python3
"""Package the AWS Lambda handler in a deployable ZIP using stdlib only.

Usage: python scripts/package_lambda.py
Creates: dist/prada-feedback-analyzer.zip
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

project_root = Path(__file__).resolve().parents[1]
source = project_root / 'backend' / 'lambda_function.py'
destination = project_root / 'dist' / 'prada-feedback-analyzer.zip'
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    archive.write(source, arcname='lambda_function.py')
print(f'Created {destination}')
