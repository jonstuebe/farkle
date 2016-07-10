import React from 'react';

import BackButton from './BackButton';

const TitleBar = React.createClass({
    render(){

        let Back = <BackButton to={this.props.back} />;
        if(this.props.back == false) Back = null;

        return (
            <header className="title-bar">
                {Back}
				<h2>{this.props.title}</h2>
            </header>
        )
    }
});

export default TitleBar;
