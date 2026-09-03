FROM public.ecr.aws/lambda/python:3.12

COPY aws/mrms-publisher/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY aws/mrms-publisher/handler_v2.py ${LAMBDA_TASK_ROOT}/handler.py
COPY scripts/radar/render_mrms_loop.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_loop.py
COPY scripts/radar/render_mrms_mosaic.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic.py
COPY scripts/radar/render_mrms_frame_bundle.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_frame_bundle.py
COPY scripts/radar/palettes/zacharologist-reflectivity.pal ${LAMBDA_TASK_ROOT}/scripts/radar/palettes/zacharologist-reflectivity.pal

CMD ["handler.lambda_handler"]
