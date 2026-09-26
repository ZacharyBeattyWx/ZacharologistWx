FROM public.ecr.aws/lambda/python:3.12

COPY aws/satellite-truecolor-publisher/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY aws/satellite-truecolor-publisher/satellite_truecolor_publisher.py ${LAMBDA_TASK_ROOT}/satellite_truecolor_publisher.py
RUN python -m py_compile ${LAMBDA_TASK_ROOT}/satellite_truecolor_publisher.py \
 && python -c "import netCDF4, numpy, PIL, pyproj; print('satellite runtime OK')"

CMD ["satellite_truecolor_publisher.lambda_handler"]
