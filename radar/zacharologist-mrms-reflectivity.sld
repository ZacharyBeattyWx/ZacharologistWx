<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>conus_bref_qcd</Name>
    <UserStyle>
      <Title>ZacharologistWx MRMS Reflectivity</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="#1c5f8c" quantity="-100" opacity="0"/>
              <ColorMapEntry color="#1c5f8c" quantity="-5.001" opacity="0"/>
              <ColorMapEntry color="#1c5f8c" quantity="-5" opacity="0.0392"/>
              <ColorMapEntry color="#2873a5" quantity="0" opacity="0.1373"/>
              <ColorMapEntry color="#46d2e6" quantity="9.999" opacity="0.4706"/>
              <ColorMapEntry color="#497598" quantity="10" opacity="0.4941"/>
              <ColorMapEntry color="#4ca58e" quantity="15" opacity="0.8039"/>
              <ColorMapEntry color="#127618" quantity="20" opacity="0.9020"/>
              <ColorMapEntry color="#cbde01" quantity="25" opacity="0.9608"/>
              <ColorMapEntry color="#d7cb00" quantity="30" opacity="1"/>
              <ColorMapEntry color="#e38103" quantity="35" opacity="1"/>
              <ColorMapEntry color="#b95f0a" quantity="40" opacity="1"/>
              <ColorMapEntry color="#c02514" quantity="45" opacity="1"/>
              <ColorMapEntry color="#ca99b4" quantity="50" opacity="1"/>
              <ColorMapEntry color="#c44a8a" quantity="55" opacity="1"/>
              <ColorMapEntry color="#8b20d2" quantity="60" opacity="1"/>
              <ColorMapEntry color="#5614a2" quantity="65" opacity="1"/>
              <ColorMapEntry color="#6fd2db" quantity="70" opacity="1"/>
              <ColorMapEntry color="#4a849a" quantity="75" opacity="1"/>
              <ColorMapEntry color="#730a01" quantity="80" opacity="1"/>
              <ColorMapEntry color="#ebbeff" quantity="85" opacity="1"/>
              <ColorMapEntry color="#ffe6f5" quantity="90" opacity="1"/>
              <ColorMapEntry color="#ffffff" quantity="95" opacity="1"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
