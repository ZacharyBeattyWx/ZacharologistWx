FROM public.ecr.aws/lambda/python:3.12

COPY aws/mrms-publisher/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Keep the proven MRMS publisher intact and wrap it with an isolated NEXRAD
# publisher. If the NEXRAD feed fails, MRMS remains independently valid.
COPY aws/mrms-publisher/handler_v2.py ${LAMBDA_TASK_ROOT}/handler_v2.py
COPY aws/mrms-publisher/nexrad_publisher.py ${LAMBDA_TASK_ROOT}/nexrad_publisher.py
COPY aws/mrms-publisher/mrala_numeric_publisher.py ${LAMBDA_TASK_ROOT}/mrala_numeric_publisher.py
COPY aws/mrms-publisher/handler_v3.py ${LAMBDA_TASK_ROOT}/handler.py

COPY scripts/radar/render_mrms_loop.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_loop.py
# Keep the shared decoder/palette implementation intact, then expose the
# production display profile under the module name used by the publisher.
COPY scripts/radar/render_mrms_mosaic.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic_base.py
COPY scripts/radar/render_mrms_mosaic_display.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic.py
COPY scripts/radar/render_mrms_frame_bundle.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_frame_bundle.py

# National NEXRAD N0B path. Keep this Lambda lean: the current production phase
# uses a local GINI parser plus pyproj rather than the full MetPy scientific stack.
COPY scripts/radar/render_unidata_nexrad_mosaic.py ${LAMBDA_TASK_ROOT}/scripts/radar/render_unidata_nexrad_mosaic.py
COPY scripts/radar/unidata_gini_lite.py ${LAMBDA_TASK_ROOT}/scripts/radar/unidata_gini_lite.py
COPY scripts/radar/palettes/zacharologist-reflectivity.pal ${LAMBDA_TASK_ROOT}/scripts/radar/palettes/zacharologist-reflectivity.pal

CMD ["handler.lambda_handler"]
